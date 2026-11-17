-- Defense in depth for the runtime database role. Safe to replay: every policy,
-- trigger and function is replaced with the same definition.
SET lock_timeout='5s';

-- B01: scoped base partition policies (fresh installs also get these in db/postgres.sql).
ALTER TABLE gymos.gym_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.gym_states FORCE ROW LEVEL SECURITY;
ALTER TABLE gymos.gym_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.gym_access FORCE ROW LEVEL SECURITY;
ALTER TABLE gymos.gym_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.gym_invites FORCE ROW LEVEL SECURITY;
ALTER TABLE gymos.gym_recovery ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.gym_recovery FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS server_access ON gymos.gym_states;
DROP POLICY IF EXISTS partition_runtime ON gymos.gym_states;
CREATE POLICY partition_runtime ON gymos.gym_states TO gymos_app
 USING(user_id=current_setting('app.gym_owner',true)) WITH CHECK(user_id=current_setting('app.gym_owner',true));
DROP POLICY IF EXISTS server_access ON gymos.gym_access;
DROP POLICY IF EXISTS partition_runtime ON gymos.gym_access;
CREATE POLICY partition_runtime ON gymos.gym_access TO gymos_app
 USING(owner_id=current_setting('app.gym_owner',true)) WITH CHECK(owner_id=current_setting('app.gym_owner',true));
DROP POLICY IF EXISTS server_access ON gymos.gym_recovery;
DROP POLICY IF EXISTS partition_runtime ON gymos.gym_recovery;
CREATE POLICY partition_runtime ON gymos.gym_recovery TO gymos_app
 USING(owner_id=current_setting('app.gym_owner',true)) WITH CHECK(owner_id=current_setting('app.gym_owner',true));
DROP POLICY IF EXISTS server_access ON gymos.gym_invites;
DROP POLICY IF EXISTS partition_runtime ON gymos.gym_invites;
DROP POLICY IF EXISTS invitation_read ON gymos.gym_invites;
DROP POLICY IF EXISTS invitation_write ON gymos.gym_invites;
CREATE POLICY invitation_read ON gymos.gym_invites FOR SELECT TO gymos_app
 USING(owner_id=current_setting('app.gym_owner',true) OR token_hash=current_setting('app.invite_token',true));
CREATE POLICY invitation_write ON gymos.gym_invites FOR ALL TO gymos_app
 USING(owner_id=current_setting('app.gym_owner',true)) WITH CHECK(owner_id=current_setting('app.gym_owner',true));

-- B02: a member may link an invitation, but may not rewrite the link's identity.
DROP POLICY IF EXISTS member_portal_update ON gymos.member_portal_access;
DROP POLICY IF EXISTS member_portal_owner_update ON gymos.member_portal_access;
DROP POLICY IF EXISTS member_portal_member_link ON gymos.member_portal_access;
CREATE POLICY member_portal_owner_update ON gymos.member_portal_access FOR UPDATE TO gymos_app
 USING(owner_id=current_setting('app.gym_owner',true)) WITH CHECK(owner_id=current_setting('app.gym_owner',true));
CREATE POLICY member_portal_member_link ON gymos.member_portal_access FOR UPDATE TO gymos_app
 USING(user_id=current_setting('app.actor',true) AND NOT revoked AND expires_at>now())
 WITH CHECK(user_id=current_setting('app.actor',true) AND invite_hash IS NULL AND NOT revoked);
CREATE OR REPLACE FUNCTION gymos.member_portal_identity_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF coalesce(current_setting('app.gym_owner',true),'')='' AND coalesce(current_setting('app.actor',true),'')<>'' THEN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id OR NEW.member_id IS DISTINCT FROM OLD.member_id
   OR NEW.branch IS DISTINCT FROM OLD.branch OR NEW.email IS DISTINCT FROM OLD.email
   OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
   RAISE EXCEPTION 'memberPortalIdentityImmutable' USING ERRCODE='42501';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS member_portal_identity_guard ON gymos.member_portal_access;
CREATE TRIGGER member_portal_identity_guard BEFORE UPDATE ON gymos.member_portal_access
 FOR EACH ROW EXECUTE FUNCTION gymos.member_portal_identity_guard();

-- B03: phone sign-in returns only the safe projection, never PIN cipher/hash columns.
DROP POLICY IF EXISTS member_phone_login ON gymos.member_code_access;
CREATE OR REPLACE FUNCTION gymos.member_phone_login(phone_digest text,pin text)
RETURNS TABLE(owner_id text,member_id text,branch text,version integer,pin_must_change boolean,matches boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,gymos,extensions AS $$
BEGIN
 IF phone_digest IS NULL OR phone_digest !~ '^[a-f0-9]{64}$' THEN RETURN; END IF;
 RETURN QUERY SELECT a.owner_id,a.member_id,a.branch,a.version,a.pin_must_change,
  gymos.member_pin_matches(pin,a.pin_hash)
 FROM gymos.member_code_access a
 WHERE a.phone_hash=phone_digest AND NOT a.revoked AND NOT a.inactive
 ORDER BY a.owner_id,a.branch,a.member_id LIMIT 21;
END $$;
REVOKE ALL ON FUNCTION gymos.member_phone_login(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION gymos.member_phone_login(text,text) TO gymos_app;

-- C01: tenant storage_key is an immutable partition identity for non-platform sessions.
CREATE OR REPLACE FUNCTION gymos.immutable_tenant_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.storage_key IS DISTINCT FROM OLD.storage_key AND coalesce(current_setting('app.platform',true),'')<>'1' THEN
  RAISE EXCEPTION 'tenantStorageKeyImmutable' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tenants_immutable_identity ON gymos.tenants;
CREATE TRIGGER tenants_immutable_identity BEFORE UPDATE OF storage_key ON gymos.tenants
 FOR EACH ROW EXECUTE FUNCTION gymos.immutable_tenant_identity();

-- C03: invalid legacy branches text must fail closed to an empty scope.
-- NULL would mean "all branches" in the runtime access context, so it must
-- never be returned for a malformed staff grant. Owner rows are inserted
-- separately with an explicit NULL and remain unrestricted by design.
CREATE OR REPLACE FUNCTION gymos.safe_branches_json(value text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
BEGIN
 IF value IS NULL THEN RETURN '[]'::jsonb; END IF;
 RETURN value::jsonb;
EXCEPTION WHEN invalid_text_representation THEN RETURN '[]'::jsonb;
END $$;
REVOKE ALL ON FUNCTION gymos.safe_branches_json(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION gymos.safe_branches_json(text) TO gymos_app;
CREATE OR REPLACE FUNCTION gymos.sync_tenant_staff() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,gymos AS $fn$
DECLARE tenant_key text; license_row gymos.tenant_licenses%ROWTYPE; staff_count integer;BEGIN
 SELECT id INTO tenant_key FROM gymos.tenants WHERE storage_key=NEW.owner_id;
 IF tenant_key IS NOT NULL THEN
  PERFORM id FROM gymos.tenants WHERE id=tenant_key FOR UPDATE;
  SELECT * INTO license_row FROM gymos.tenant_licenses WHERE tenant_id=tenant_key;
  IF NEW.revoked=0 AND (license_row.status<>'active' OR license_row.starts_at IS NULL OR license_row.starts_at>now() OR (license_row.mode<>'perpetual' AND (license_row.ends_at IS NULL OR license_row.ends_at<=now()))) THEN RAISE EXCEPTION 'licenseReadOnly' USING ERRCODE='42501';END IF;
  IF NEW.revoked=0 AND NOT EXISTS(SELECT 1 FROM gymos.tenant_memberships WHERE tenant_id=tenant_key AND user_id=NEW.user_id AND NOT revoked) THEN
   SELECT count(*) INTO staff_count FROM gymos.tenant_memberships WHERE tenant_id=tenant_key AND NOT revoked AND role<>'owner';
   IF staff_count>=(license_row.limits->>'staff')::integer THEN RAISE EXCEPTION 'staffLimit' USING ERRCODE='42501';END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM gymos.tenant_memberships WHERE tenant_id=tenant_key AND user_id=NEW.user_id AND role='owner' AND NOT revoked) THEN RAISE EXCEPTION 'owner_protected' USING ERRCODE='42501';END IF;
  INSERT INTO gymos.tenant_memberships(tenant_id,user_id,role,branches,name,revoked) VALUES(tenant_key,NEW.user_id,NEW.role,gymos.safe_branches_json(NEW.branches),NEW.name,NEW.revoked<>0)
  ON CONFLICT(tenant_id,user_id) DO UPDATE SET role=excluded.role,branches=excluded.branches,name=excluded.name,revoked=excluded.revoked;
 END IF;RETURN NEW;END $fn$;
