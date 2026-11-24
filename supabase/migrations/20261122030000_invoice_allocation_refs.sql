-- HELD DRAFT, not applied anywhere. Review only. FRESH INSTALL ONLY: no upgrade path from earlier drafts of this migration (they are unreleased); on a database that already holds invoices every owner starts unready and must go through scripts/refs-ready.mjs. Shared allocation-reference source for Reports payment rows and member-credit reads.
-- Why: the payload GIN probe (20261121250000) and every payload expression (->>, jsonb_array_elements, &&, @>) are not leakproof, so under ENABLE+FORCE RLS (gymos_app) they cannot be Index Cond and the
-- planner scans every invoice of the owner. Here every probe predicate is a plain column compare (texteq / int ordering, leakproof), so it can be an index condition under the owner policy.
-- Semantics kept exactly: an element is stored only when it is a JSON object whose `payment` is a JSON string (legacy matches with ===); ord is its position in payload.allocations; has_minor/minor keep
-- absent vs null vs number apart. Invoice voided/category are NOT copied (the reader takes them from the invoice row, so they cannot go stale). Invoice position and branch are copied so ordering and branch scope need no payload read.
-- Skipped elements: an element that is not a JSON object, or whose `payment` is not a JSON string, can never equal a string payment id under legacy ===, so omitting it cannot change any read that matches a string id
-- (the Reports reader refuses non-string page payment ids before it reads refs). A consumer that needs those elements (e.g. an allocation-sum over ALL elements) must not use this relation for them.
-- Index key: payment_key = md5(payment_id) (fixed 32 chars), so an oversized payment id can never exceed the btree row limit; payment_id itself stays in the heap and the reader repeats the exact equality, so a hash collision cannot change a result.
-- Writer: AFTER row triggers on gym_entities in the same transaction as the invoice write, using the restricted NOLOGIN maintenance definer role and exact trigger-context checks. NO exception is swallowed:
-- if a ref write fails the whole invoice write rolls back (a failed ref write is a database failure, and a stale ref set must never exist). AFTER TRUNCATE clears the refs too; owner deletion is row DELETE and is covered.
-- Backfill locks each invoice row (FOR UPDATE) before rebuilding it so a concurrent writer cannot be overwritten by an older payload.
-- Readiness: readers use the refs only while invoice_allocation_refs_state has key 'complete' (set by the migration when no invoice exists yet, else only by the held backfill after a zero-mismatch check).
-- Direct writes: gymos_app has NO write access to refs/odd/state (SELECT only); only the maintenance-role trigger functions and the migration role write them.
-- Rollback: disable dependent readers first; retain payload as source of truth. Any trigger/schema rollback is a separately authorized operational change, never an automatic DROP.
CREATE TABLE IF NOT EXISTS gymos.invoice_allocation_refs(
  owner_id text NOT NULL, invoice_id text NOT NULL, ord integer NOT NULL, payment_id text NOT NULL, payment_key text NOT NULL,
  has_minor boolean NOT NULL, minor jsonb, invoice_position integer NOT NULL, invoice_branch text,
  PRIMARY KEY(owner_id,invoice_id,ord));
CREATE INDEX IF NOT EXISTS invoice_allocation_refs_payment ON gymos.invoice_allocation_refs(owner_id,payment_key,invoice_position,invoice_id,ord);
-- Invoices whose allocations have a shape the refs cannot represent (payload.allocations present but not an array, or any element that is not an object with a string payment). A consumer that must refuse unsupported shapes
-- (member-credit) checks this table (an owner-prefix probe); the Reports reader needs no refusal because such elements cannot match a string payment id.
CREATE TABLE IF NOT EXISTS gymos.invoice_allocation_odd(owner_id text NOT NULL, invoice_id text NOT NULL, odd_elements integer NOT NULL, invoice_branch text, PRIMARY KEY(owner_id,invoice_id));
-- Per-owner readiness: a row with ready=true means every invoice of that owner has exact refs/odd rows (set only by invoice_allocation_refs_complete after a zero-mismatch check; ready=false is a tombstone; an owner with no state row and no invoices is treated as ready by the reader, an owner with invoices and no ready row is not).
CREATE TABLE IF NOT EXISTS gymos.invoice_allocation_refs_state(owner_id text PRIMARY KEY, set_at timestamptz NOT NULL DEFAULT now(), ready boolean NOT NULL DEFAULT true);
-- ready=false is a TOMBSTONE written when a restore generation changes (or the metadata row is deleted): it keeps the owner unready (and no write path can re-ready it) until the migration-authorized rebuild+complete flips it.

-- the single definition of "which refs does this invoice have", used by the trigger, the backfill and the verification
CREATE OR REPLACE FUNCTION gymos.invoice_allocation_ref_rows(p_owner text,p_invoice text,p_position integer,p_branch text,p_payload jsonb)
RETURNS TABLE(owner_id text,invoice_id text,ord integer,payment_id text,payment_key text,has_minor boolean,minor jsonb,invoice_position integer,invoice_branch text)
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT p_owner,p_invoice,(a.ord-1)::integer,a.v->>'payment',md5(a.v->>'payment'),(a.v ? 'minor'),a.v->'minor',p_position,p_branch
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_payload->'allocations')='array' THEN p_payload->'allocations' ELSE '[]'::jsonb END) WITH ORDINALITY a(v,ord)
  WHERE jsonb_typeof(a.v)='object' AND jsonb_typeof(a.v->'payment')='string' $$;

-- count of unsupported allocation shapes of one invoice (0 = every element is represented). The real ledger functions (paymentAvailable, invoiceOutstanding, paymentBreakdown) call `invoice.allocations.filter` directly,
-- so a missing key, JSON null or any non-array value THROWS for a non-voided invoice: it is counted as 1 (unsupported, a consumer must refuse), regardless of the invoice's voided flag (conservative: a voided invoice with such a shape
-- is refused too rather than modelling JS truthiness of `voided` here). An element that is not an object with a string payment (a null element throws on `.payment`) is counted per element.
CREATE OR REPLACE FUNCTION gymos.invoice_allocation_odd_count(p_payload jsonb) RETURNS integer LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(p_payload->'allocations') IS DISTINCT FROM 'array' THEN 1
              ELSE (SELECT count(*)::integer FROM jsonb_array_elements(p_payload->'allocations') a WHERE NOT COALESCE(jsonb_typeof(a)='object' AND jsonb_typeof(a->'payment')='string',false)) END $$;
-- Maintenance principal: a NOLOGIN, non-superuser, non-BYPASSRLS role that owns ONLY the four trigger functions below. The runtime role (gymos_app) has SELECT only on refs/odd/state, so it can neither forge,
-- delete nor claim readiness. The functions are SECURITY DEFINER trigger functions (they cannot be called as ordinary functions). The maintenance role needs NO access to gym_entities or gym_states: it derives everything from OLD/NEW, pinned to pg_catalog, fully qualified, no dynamic SQL, no owner argument: they derive everything
-- from the real OLD/NEW source row of gymos.gym_entities and fail (rolling back the source write) on any error. Local review candidate only: nothing here is applied to a remote database.
DO $r$ DECLARE r pg_roles%ROWTYPE; bad text; db oid:=(SELECT oid FROM pg_database WHERE datname=current_database());
BEGIN
  SELECT * INTO r FROM pg_roles WHERE rolname='gymos_refs_maint';
  IF NOT FOUND THEN
    CREATE ROLE gymos_refs_maint NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT NOREPLICATION;
  ELSE
    -- A pre-existing role is NOT trusted. It must have exactly the safe attributes, no memberships either way except the provider creator-admin edge, no role-level settings, and EVERY dependency recorded for it in pg_shdepend (ownership 'o', any ACL entry incl. column,
    -- schema, function, default and database ACLs 'a', policy references 'r') must be one of the exact identities below, with exactly the intended privileges and no grant option. Anything else fails closed.
    IF r.rolsuper OR r.rolbypassrls OR r.rolcanlogin OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolinherit OR r.rolconnlimit<>-1 THEN RAISE EXCEPTION 'gymos_refs_maint exists with unsafe attributes; refusing to use it'; END IF;
    IF EXISTS (SELECT 1 FROM pg_auth_members m WHERE (m.roleid=r.oid OR m.member=r.oid) AND NOT COALESCE((
      m.roleid=r.oid AND m.member=(SELECT oid FROM pg_roles WHERE rolname='postgres')
      AND m.grantor=(SELECT oid FROM pg_roles WHERE rolname='supabase_admin' AND rolsuper)
      AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option
    ),false)) THEN RAISE EXCEPTION 'gymos_refs_maint has unsafe role memberships; refusing to use it'; END IF;
    IF EXISTS (SELECT 1 FROM pg_db_role_setting d WHERE d.setrole=r.oid) THEN RAISE EXCEPTION 'gymos_refs_maint has role settings; refusing to use it'; END IF;
    IF EXISTS (SELECT 1 FROM pg_default_acl d WHERE d.defaclrole=r.oid OR EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) x WHERE x.grantee=r.oid OR x.grantor=r.oid)) THEN RAISE EXCEPTION 'gymos_refs_maint appears in default ACLs; refusing to use it'; END IF;
    SELECT string_agg(x,',') INTO bad FROM (
      SELECT format('%s/%s/%s/%s',d.dbid,d.classid::regclass,d.objid,d.deptype) AS x FROM pg_shdepend d
      WHERE d.refclassid='pg_authid'::regclass AND d.refobjid=r.oid AND d.deptype<>'p' AND NOT (
        d.dbid=db AND (
          -- owned objects: exactly our four trigger functions (by schema, name and identity arguments, so no overload is accepted)
          (d.deptype='o' AND d.classid='pg_proc'::regclass AND EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=d.objid AND p.pronamespace='gymos'::regnamespace AND
              p.proname IN ('invoice_allocation_refs_sync','invoice_allocation_refs_truncate','invoice_allocation_refs_epoch','invoice_allocation_refs_epoch_truncate') AND pg_get_function_identity_arguments(p.oid)=''))
          -- ACL entries (objsubid 0 = object level, never a column ACL): the three tables, schema gymos, and EXECUTE on exactly two helper functions
          OR (d.deptype='a' AND d.objsubid=0 AND (
              (d.classid='pg_class'::regclass AND d.objid IN ('gymos.invoice_allocation_refs'::regclass,'gymos.invoice_allocation_odd'::regclass,'gymos.invoice_allocation_refs_state'::regclass))
              OR (d.classid='pg_namespace'::regclass AND d.objid='gymos'::regnamespace)
              OR (d.classid='pg_proc'::regclass AND EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=d.objid AND p.pronamespace='gymos'::regnamespace AND (
                   (p.proname='invoice_allocation_ref_rows' AND pg_get_function_identity_arguments(p.oid)='p_owner text, p_invoice text, p_position integer, p_branch text, p_payload jsonb')
                OR (p.proname='invoice_allocation_odd_count' AND pg_get_function_identity_arguments(p.oid)='p_payload jsonb'))))))
          -- policies: exactly the three maintenance policies
          OR (d.deptype='r' AND d.classid='pg_policy'::regclass AND EXISTS (SELECT 1 FROM pg_policy o WHERE o.oid=d.objid AND o.polname IN ('invoice_allocation_refs_maint','invoice_allocation_odd_maint','invoice_allocation_refs_state_maint')
              AND o.polrelid IN ('gymos.invoice_allocation_refs'::regclass,'gymos.invoice_allocation_odd'::regclass,'gymos.invoice_allocation_refs_state'::regclass)))
        ))) q;
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'gymos_refs_maint has unrelated ownership, ACL or policy dependencies: %',bad; END IF;
    -- exact effective privileges on the allowed objects, no grant option, no column ACLs
    IF EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attacl IS NOT NULL AND EXISTS (SELECT 1 FROM aclexplode(a.attacl) x WHERE x.grantee=r.oid)) THEN RAISE EXCEPTION 'gymos_refs_maint holds column privileges; refusing to use it'; END IF;
    SELECT string_agg(c.relname||':'||x.privilege_type||CASE WHEN x.is_grantable THEN '+grant' ELSE '' END,',') INTO bad FROM pg_class c,aclexplode(c.relacl) x
      WHERE x.grantee=r.oid AND NOT (NOT x.is_grantable AND c.relnamespace='gymos'::regnamespace AND (
        (c.relname IN ('invoice_allocation_refs','invoice_allocation_odd','invoice_allocation_refs_state') AND x.privilege_type IN ('SELECT','INSERT','DELETE','TRUNCATE'))
        OR (c.relname='invoice_allocation_refs_state' AND x.privilege_type='UPDATE')));
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'gymos_refs_maint holds unintended table privileges: %',bad; END IF;
    SELECT string_agg(n.nspname||':'||x.privilege_type,',') INTO bad FROM pg_namespace n,aclexplode(n.nspacl) x WHERE x.grantee=r.oid AND NOT (n.nspname='gymos' AND x.privilege_type='USAGE' AND NOT x.is_grantable);
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'gymos_refs_maint holds unintended schema privileges: %',bad; END IF;
    SELECT string_agg(p.proname||':'||x.privilege_type,',') INTO bad FROM pg_proc p,aclexplode(p.proacl) x WHERE x.grantee=r.oid AND x.privilege_type<>'EXECUTE' OR (x.grantee=r.oid AND x.privilege_type='EXECUTE' AND NOT (p.pronamespace='gymos'::regnamespace AND (
        (NOT x.is_grantable AND p.proname IN ('invoice_allocation_ref_rows','invoice_allocation_odd_count'))
        OR (p.proowner=r.oid AND p.proname IN ('invoice_allocation_refs_sync','invoice_allocation_refs_truncate','invoice_allocation_refs_epoch','invoice_allocation_refs_epoch_truncate') AND pg_get_function_identity_arguments(p.oid)=''))));
    IF bad IS NOT NULL THEN RAISE EXCEPTION 'gymos_refs_maint holds unintended function privileges: %',bad; END IF;
  END IF;
END $r$;
CREATE OR REPLACE FUNCTION gymos.invoice_allocation_refs_sync() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_RELID IS DISTINCT FROM 'gymos.gym_entities'::regclass OR TG_LEVEL<>'ROW' OR TG_WHEN<>'AFTER' OR TG_NARGS<>0 OR TG_OP NOT IN ('INSERT','UPDATE','DELETE') OR pg_trigger_depth()<>1 THEN
    RAISE EXCEPTION 'invoice_allocation_refs_sync: unexpected trigger context';
  END IF;
  IF TG_OP IN ('UPDATE','DELETE') AND OLD.collection='invoices' THEN DELETE FROM gymos.invoice_allocation_refs WHERE owner_id=OLD.owner_id AND invoice_id=OLD.entity_id;DELETE FROM gymos.invoice_allocation_odd WHERE owner_id=OLD.owner_id AND invoice_id=OLD.entity_id; END IF;
  IF TG_OP IN ('INSERT','UPDATE') AND NEW.collection='invoices' THEN
    INSERT INTO gymos.invoice_allocation_refs SELECT * FROM gymos.invoice_allocation_ref_rows(NEW.owner_id,NEW.entity_id,NEW.position,NEW.branch,NEW.payload);
    INSERT INTO gymos.invoice_allocation_odd SELECT NEW.owner_id,NEW.entity_id,gymos.invoice_allocation_odd_count(NEW.payload),NEW.branch WHERE gymos.invoice_allocation_odd_count(NEW.payload)>0;
  END IF;
  -- NO automatic readiness claim: readiness is only ever set by the migration-authorized complete() after an exact rebuild/verification. A virgin owner and an invalidated (restored) owner are therefore never confused.
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION gymos.invoice_allocation_refs_truncate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_RELID IS DISTINCT FROM 'gymos.gym_entities'::regclass OR TG_LEVEL<>'STATEMENT' OR TG_OP<>'TRUNCATE' OR TG_NARGS<>0 THEN RAISE EXCEPTION 'invoice_allocation_refs_truncate: unexpected trigger context'; END IF;
  TRUNCATE gymos.invoice_allocation_refs,gymos.invoice_allocation_odd,gymos.invoice_allocation_refs_state; RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION gymos.invoice_allocation_refs_sync(),gymos.invoice_allocation_refs_truncate() FROM PUBLIC,anon,authenticated,gymos_app;
DROP TRIGGER IF EXISTS invoice_allocation_refs_ins ON gymos.gym_entities;
CREATE TRIGGER invoice_allocation_refs_ins AFTER INSERT ON gymos.gym_entities FOR EACH ROW WHEN (NEW.collection='invoices') EXECUTE FUNCTION gymos.invoice_allocation_refs_sync();
DROP TRIGGER IF EXISTS invoice_allocation_refs_upd ON gymos.gym_entities;
CREATE TRIGGER invoice_allocation_refs_upd AFTER UPDATE ON gymos.gym_entities FOR EACH ROW WHEN ((NEW.collection='invoices' OR OLD.collection='invoices') AND (OLD.payload->'allocations' IS DISTINCT FROM NEW.payload->'allocations' OR OLD.position IS DISTINCT FROM NEW.position OR OLD.branch IS DISTINCT FROM NEW.branch OR OLD.entity_id IS DISTINCT FROM NEW.entity_id OR OLD.owner_id IS DISTINCT FROM NEW.owner_id OR OLD.collection IS DISTINCT FROM NEW.collection)) EXECUTE FUNCTION gymos.invoice_allocation_refs_sync();
DROP TRIGGER IF EXISTS invoice_allocation_refs_del ON gymos.gym_entities;
CREATE TRIGGER invoice_allocation_refs_del AFTER DELETE ON gymos.gym_entities FOR EACH ROW WHEN (OLD.collection='invoices') EXECUTE FUNCTION gymos.invoice_allocation_refs_sync();
DROP TRIGGER IF EXISTS invoice_allocation_refs_trunc ON gymos.gym_entities;
CREATE TRIGGER invoice_allocation_refs_trunc AFTER TRUNCATE ON gymos.gym_entities FOR EACH STATEMENT EXECUTE FUNCTION gymos.invoice_allocation_refs_truncate();
-- an UPDATE that moves a row out of (or into) 'invoices' fires on OLD or NEW identity: old refs/odd are deleted only if OLD was an invoice, new ones inserted only if NEW is an invoice.

-- held backfill + verification (idempotent, per owner, batched by invoice id; run by the migration role with app.gym_owner set when RLS applies)
CREATE OR REPLACE FUNCTION gymos.invoice_allocation_refs_rebuild(p_owner text,p_after text,p_limit integer) RETURNS text LANGUAGE plpgsql AS $$
DECLARE last_id text; r record; n integer:=0;
BEGIN
  PERFORM 1 FROM gymos.gym_states WHERE user_id=p_owner FOR SHARE; -- same order as restore (owner gym_states row first, then invoice rows); never the reverse
  FOR r IN SELECT entity_id,position,branch,payload FROM gymos.gym_entities WHERE owner_id=p_owner AND collection='invoices' AND (p_after IS NULL OR entity_id>p_after) ORDER BY entity_id LIMIT p_limit FOR UPDATE LOOP
    DELETE FROM gymos.invoice_allocation_refs WHERE owner_id=p_owner AND invoice_id=r.entity_id;DELETE FROM gymos.invoice_allocation_odd WHERE owner_id=p_owner AND invoice_id=r.entity_id;
    INSERT INTO gymos.invoice_allocation_refs SELECT * FROM gymos.invoice_allocation_ref_rows(p_owner,r.entity_id,r.position,r.branch,r.payload);
    INSERT INTO gymos.invoice_allocation_odd SELECT p_owner,r.entity_id,gymos.invoice_allocation_odd_count(r.payload),r.branch WHERE gymos.invoice_allocation_odd_count(r.payload)>0;
    last_id:=r.entity_id;n:=n+1;
  END LOOP;
  RETURN CASE WHEN n<p_limit THEN NULL ELSE last_id END; -- NULL = finished
END $$;
-- number of invoices of the owner whose stored refs differ from a recomputation, plus refs of invoices that no longer exist; must be 0 before 'complete' is set
CREATE OR REPLACE FUNCTION gymos.invoice_allocation_refs_mismatches(p_owner text) RETURNS bigint LANGUAGE sql STABLE AS $$
  -- every alternative is scoped to p_owner (and to invoices) before any OR: nothing here may depend on another tenant's rows
  SELECT (SELECT count(*) FROM gymos.gym_entities i WHERE i.owner_id=p_owner AND i.collection='invoices' AND
    (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.ord),'[]'::jsonb) FROM gymos.invoice_allocation_refs x WHERE x.owner_id=p_owner AND x.invoice_id=i.entity_id)
    IS DISTINCT FROM
    (SELECT COALESCE(jsonb_agg(to_jsonb(y) ORDER BY y.ord),'[]'::jsonb) FROM gymos.invoice_allocation_ref_rows(p_owner,i.entity_id,i.position,i.branch,i.payload) y))
  + (SELECT count(*) FROM gymos.gym_entities i WHERE i.owner_id=p_owner AND i.collection='invoices' AND (
       COALESCE((SELECT o.odd_elements FROM gymos.invoice_allocation_odd o WHERE o.owner_id=p_owner AND o.invoice_id=i.entity_id),0)<>gymos.invoice_allocation_odd_count(i.payload)
       OR EXISTS (SELECT 1 FROM gymos.invoice_allocation_odd o WHERE o.owner_id=p_owner AND o.invoice_id=i.entity_id AND o.invoice_branch IS DISTINCT FROM i.branch)))
  + (SELECT count(DISTINCT x.invoice_id) FROM gymos.invoice_allocation_refs x WHERE x.owner_id=p_owner AND NOT EXISTS (SELECT 1 FROM gymos.gym_entities i WHERE i.owner_id=p_owner AND i.collection='invoices' AND i.entity_id=x.invoice_id))
  + (SELECT count(*) FROM gymos.invoice_allocation_odd o WHERE o.owner_id=p_owner AND NOT EXISTS (SELECT 1 FROM gymos.gym_entities i WHERE i.owner_id=p_owner AND i.collection='invoices' AND i.entity_id=o.invoice_id)) $$;

-- Readiness is per owner. Marking an owner complete: only after the batched rebuild finished and a zero-mismatch check, both under one advisory lock so two completions cannot interleave. Triggers must be installed
-- BEFORE the backfill: any invoice write committing during the backfill maintains its own refs in its transaction, so only pre-existing rows can be missing and the mismatch check covers exactly those. A restore/replace of gym_entities that
-- bypasses triggers must set the owner's state to ready=false (or rely on the generation tombstone) and repeat rebuild + complete.
DROP FUNCTION IF EXISTS gymos.invoice_allocation_refs_complete(text,text);
-- p_expected_generation = the jsonb text of payload->'generation' that the caller read BEFORE its rebuild (NULL = the key was absent). Completion is refused (false, tombstone untouched) if the owner's metadata is missing, unparseable
-- or its generation differs now, so a restore between the final rebuild batch and completion is never silently warmed.
CREATE OR REPLACE FUNCTION gymos.invoice_allocation_refs_complete(p_owner text,p_expected_generation text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE cur text; have boolean;
BEGIN
  -- Lock order (shared with persistSpace restore, which locks the owner's gym_states row FIRST, then writes entities, then the metadata UPDATE): take the owner's gym_states row FOR SHARE before reading anything.
  -- A restore then either committed before this lock (the generation compare below and the mismatch check, a fresh READ COMMITTED statement, see it) or blocks until this transaction commits and then writes its tombstone AFTER our
  -- ready=true, so a committed tombstone is never overwritten by a stale completion. Refused under a snapshot-fixed isolation level.
  IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'invoice_allocation_refs_complete requires READ COMMITTED'; END IF;
  -- NOT bounded from inside: a timeout set by a statement inside this function does not bound the already-running `SELECT complete(...)`. The caller (scripts/refs-ready.mjs) must run SET LOCAL lock_timeout and
  -- statement_timeout as a SEPARATE completed command in the same transaction BEFORE invoking this function, bound connect/acquire/cleanup client-side, and ROLLBACK + dispose the connection on any timeout.
  SELECT true INTO have FROM gymos.gym_states g WHERE g.user_id=p_owner FOR SHARE;
  BEGIN SELECT ((g.payload::jsonb)->'generation')::text INTO cur FROM gymos.gym_states g WHERE g.user_id=p_owner; EXCEPTION WHEN data_exception THEN RETURN false; END; -- unparseable metadata: refuse
  IF NOT COALESCE(have,false) THEN RETURN false; END IF;
  IF cur IS DISTINCT FROM p_expected_generation THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('invoice_allocation_refs:'||p_owner));
  IF gymos.invoice_allocation_refs_mismatches(p_owner)<>0 THEN RETURN false; END IF;
  INSERT INTO gymos.invoice_allocation_refs_state(owner_id,ready) VALUES(p_owner,true) ON CONFLICT (owner_id) DO UPDATE SET ready=true,set_at=now();RETURN true;
END $$;

ALTER TABLE gymos.invoice_allocation_refs ENABLE ROW LEVEL SECURITY;ALTER TABLE gymos.invoice_allocation_refs FORCE ROW LEVEL SECURITY;
ALTER TABLE gymos.invoice_allocation_odd ENABLE ROW LEVEL SECURITY;ALTER TABLE gymos.invoice_allocation_odd FORCE ROW LEVEL SECURITY;
ALTER TABLE gymos.invoice_allocation_refs_state ENABLE ROW LEVEL SECURITY;ALTER TABLE gymos.invoice_allocation_refs_state FORCE ROW LEVEL SECURITY;
DO $p$ BEGIN
 -- runtime: owner-scoped SELECT only. maintenance role: the trigger writers (derive rows from the real source row, no owner argument).
 DROP POLICY IF EXISTS invoice_allocation_refs_runtime ON gymos.invoice_allocation_refs;DROP POLICY IF EXISTS invoice_allocation_odd_runtime ON gymos.invoice_allocation_odd;DROP POLICY IF EXISTS invoice_allocation_refs_state_read ON gymos.invoice_allocation_refs_state;
 CREATE POLICY invoice_allocation_refs_runtime ON gymos.invoice_allocation_refs FOR SELECT TO gymos_app USING(owner_id=current_setting('app.gym_owner',true));
 CREATE POLICY invoice_allocation_odd_runtime ON gymos.invoice_allocation_odd FOR SELECT TO gymos_app USING(owner_id=current_setting('app.gym_owner',true));
 CREATE POLICY invoice_allocation_refs_state_read ON gymos.invoice_allocation_refs_state FOR SELECT TO gymos_app USING(owner_id=current_setting('app.gym_owner',true));
 CREATE POLICY invoice_allocation_refs_maint ON gymos.invoice_allocation_refs TO gymos_refs_maint USING(true) WITH CHECK(true);
 CREATE POLICY invoice_allocation_odd_maint ON gymos.invoice_allocation_odd TO gymos_refs_maint USING(true) WITH CHECK(true);
 CREATE POLICY invoice_allocation_refs_state_maint ON gymos.invoice_allocation_refs_state TO gymos_refs_maint USING(true) WITH CHECK(true);
 END $p$;
REVOKE ALL ON gymos.invoice_allocation_refs,gymos.invoice_allocation_odd,gymos.invoice_allocation_refs_state FROM PUBLIC,anon,authenticated,gymos_app;
GRANT SELECT ON gymos.invoice_allocation_refs,gymos.invoice_allocation_odd,gymos.invoice_allocation_refs_state TO gymos_app;
GRANT USAGE ON SCHEMA gymos TO gymos_refs_maint;
GRANT SELECT,INSERT,DELETE,TRUNCATE ON gymos.invoice_allocation_refs,gymos.invoice_allocation_odd,gymos.invoice_allocation_refs_state TO gymos_refs_maint;
GRANT UPDATE ON gymos.invoice_allocation_refs_state TO gymos_refs_maint;
GRANT EXECUTE ON FUNCTION gymos.invoice_allocation_ref_rows(text,text,integer,text,jsonb),gymos.invoice_allocation_odd_count(jsonb) TO gymos_refs_maint;
-- backfill/readiness authority is the migration role only (invoker functions with EXECUTE revoked from the runtime role; they run as the migration role); the migration role must be able to write the tables under FORCE RLS (BYPASSRLS, as on the non-superuser Supabase postgres role).
REVOKE ALL ON FUNCTION gymos.invoice_allocation_refs_rebuild(text,text,integer),gymos.invoice_allocation_refs_complete(text,text),gymos.invoice_allocation_refs_mismatches(text) FROM PUBLIC,anon,authenticated,gymos_app;

-- Ordinary payment day key (plain columns, so a day range is an Index Cond under RLS instead of a payload-expression Filter). pay_day holds the day only when it is the canonical string; pay_day_odd marks every other payments row
-- (non-string or non-canonical day) so readers can still refuse them exactly. Held: adding stored generated columns rewrites gym_entities (do it in the cutover window or on the fresh rebuild).
-- ONE statement for all four stored generated columns: one table rewrite and one ACCESS EXCLUSIVE lock for this migration (not four). Hosted execution plan: docs/hosted-schema-plan.md.
ALTER TABLE gymos.gym_entities
  ADD COLUMN IF NOT EXISTS pay_day text COLLATE "C" GENERATED ALWAYS AS (CASE WHEN collection='payments' AND jsonb_typeof(payload->'day')='string' AND payload->>'day' ~ '^\d{4}-\d\d-\d\d$' THEN payload->>'day' END) STORED,
  ADD COLUMN IF NOT EXISTS pay_day_odd boolean GENERATED ALWAYS AS (collection='payments' AND NOT COALESCE(jsonb_typeof(payload->'day')='string' AND payload->>'day' ~ '^\d{4}-\d\d-\d\d$',false)) STORED,
  ADD COLUMN IF NOT EXISTS visit_at text COLLATE "C" GENERATED ALWAYS AS (CASE WHEN collection='visits' AND jsonb_typeof(payload->'at')='string' AND payload->>'at' ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$' THEN payload->>'at' END) STORED,
  ADD COLUMN IF NOT EXISTS visit_odd boolean GENERATED ALWAYS AS (collection='visits' AND NOT COALESCE(jsonb_typeof(payload->'day')='string' AND payload->>'day' ~ '^\d{4}-\d\d-\d\d$' AND jsonb_typeof(payload->'at')='string' AND payload->>'at' ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$',false)) STORED;
CREATE INDEX IF NOT EXISTS gym_entities_pay_day ON gymos.gym_entities(owner_id,branch,pay_day,position,entity_id) WHERE collection='payments' AND pay_day IS NOT NULL;
CREATE INDEX IF NOT EXISTS gym_entities_pay_day_odd ON gymos.gym_entities(owner_id,branch) WHERE pay_day_odd;

-- Visit page keys (plain columns for the same RLS reason). visit_at holds `at` only when it is the canonical UTC millisecond string; visit_odd marks every visits row whose day or `at` is non-canonical (exactly the legacy
-- readers' irregular predicate: demand_visit_day (020000) is non-null exactly when the day is a canonical string). Readers use the odd probe as an exact guard and repeat the partial-index predicates verbatim.
-- Same held-rewrite caveat as pay_day. The member-odd probe uses the 020000 demand_member_hash IS NULL (non-string member) through its own partial index.
CREATE INDEX IF NOT EXISTS gym_entities_visit_odd ON gymos.gym_entities(owner_id,branch,position,entity_id) WHERE visit_odd;
CREATE INDEX IF NOT EXISTS gym_entities_visit_member_odd ON gymos.gym_entities(owner_id,branch) WHERE collection='visits' AND demand_member_hash IS NULL;
CREATE INDEX IF NOT EXISTS gym_entities_visit_day_count ON gymos.gym_entities(owner_id,branch,demand_visit_day) WHERE collection='visits' AND demand_visit_day IS NOT NULL;
CREATE INDEX IF NOT EXISTS gym_entities_visit_canon_order ON gymos.gym_entities(owner_id,branch,demand_visit_day DESC,visit_at DESC,position,entity_id) WHERE collection='visits' AND NOT visit_odd;

-- Restore generation invalidation (contract with the executor: gym_states.payload is text metadata JSON; an optional string `generation` is assigned a fresh UUID by persistSpace restore=true, and the metadata UPDATE runs after every
-- invoice diff of that transaction). Whenever the parsed generation OLD vs NEW differs (IS DISTINCT FROM, including type changes and a restore with no invoice diff), or the row's owner identity changes, or the row is deleted, the owner's readiness
-- row is turned into a tombstone (ready=false) in the SAME transaction, so readiness is absent at commit and readers answer 'refs-not-ready' until the migration-authorized rebuild + complete runs. Unparseable metadata on either side counts as changed (fail closed). The only
-- caught error is the JSON cast itself. The trigger fires only when the metadata text differs.
CREATE OR REPLACE FUNCTION gymos.invoice_allocation_refs_epoch() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE changed boolean;
BEGIN
  IF TG_RELID IS DISTINCT FROM 'gymos.gym_states'::regclass OR TG_LEVEL<>'ROW' OR TG_WHEN<>'AFTER' OR TG_NARGS<>0 OR TG_OP NOT IN ('UPDATE','DELETE') OR pg_trigger_depth()<>1 THEN
    RAISE EXCEPTION 'invoice_allocation_refs_epoch: unexpected trigger context';
  END IF;
  IF TG_OP='DELETE' THEN changed:=true;
  ELSE
    BEGIN changed:=((OLD.payload::jsonb)->'generation') IS DISTINCT FROM ((NEW.payload::jsonb)->'generation') OR OLD.user_id IS DISTINCT FROM NEW.user_id;
    EXCEPTION WHEN data_exception THEN changed:=true; END;
  END IF;
  IF changed THEN
    INSERT INTO gymos.invoice_allocation_refs_state(owner_id,ready) VALUES(OLD.user_id,false) ON CONFLICT (owner_id) DO UPDATE SET ready=false,set_at=now();
    IF TG_OP='UPDATE' THEN INSERT INTO gymos.invoice_allocation_refs_state(owner_id,ready) VALUES(NEW.user_id,false) ON CONFLICT (owner_id) DO UPDATE SET ready=false,set_at=now(); END IF;
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION gymos.invoice_allocation_refs_epoch() FROM PUBLIC,anon,authenticated,gymos_app;
DROP TRIGGER IF EXISTS invoice_allocation_refs_epoch_upd ON gymos.gym_states;
CREATE TRIGGER invoice_allocation_refs_epoch_upd AFTER UPDATE ON gymos.gym_states FOR EACH ROW WHEN (OLD.payload IS DISTINCT FROM NEW.payload OR OLD.user_id IS DISTINCT FROM NEW.user_id) EXECUTE FUNCTION gymos.invoice_allocation_refs_epoch();
DROP TRIGGER IF EXISTS invoice_allocation_refs_epoch_del ON gymos.gym_states;
CREATE TRIGGER invoice_allocation_refs_epoch_del AFTER DELETE ON gymos.gym_states FOR EACH ROW EXECUTE FUNCTION gymos.invoice_allocation_refs_epoch();
CREATE OR REPLACE FUNCTION gymos.invoice_allocation_refs_epoch_truncate() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
  IF TG_RELID IS DISTINCT FROM 'gymos.gym_states'::regclass OR TG_LEVEL<>'STATEMENT' OR TG_OP<>'TRUNCATE' THEN RAISE EXCEPTION 'invoice_allocation_refs_epoch_truncate: unexpected trigger context'; END IF;
  UPDATE gymos.invoice_allocation_refs_state SET ready=false,set_at=now(); RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION gymos.invoice_allocation_refs_epoch_truncate() FROM PUBLIC,anon,authenticated,gymos_app;
DROP TRIGGER IF EXISTS invoice_allocation_refs_epoch_trunc ON gymos.gym_states;
CREATE TRIGGER invoice_allocation_refs_epoch_trunc AFTER TRUNCATE ON gymos.gym_states FOR EACH STATEMENT EXECUTE FUNCTION gymos.invoice_allocation_refs_epoch_truncate();
-- SUPPORTED CONTRACT: ordinary application (origin-role) writes only: persistSpace upserts/removals/restore/import, owner delete, TRUNCATE. For those the row triggers keep the refs exact, or the epoch triggers tombstone the owner, in the same transaction.
-- EXCLUDED while any reader is live: session_replication_role=replica / logical-replication apply, ALTER TABLE ... DISABLE TRIGGER (pg_restore --disable-triggers) and any other trigger-bypass import. The existing owner-version triggers are origin-only as well, so such writes also skip the version bump
-- that snapshot checks, caches and summaries rely on. Such an import needs readers disabled externally, then a trusted new epoch/version, rebuild, verify and reopen (docs/refs-restore-runbook.md). Triggers here are deliberately plain (origin) triggers.

-- Hosted postgres is not a superuser. Its provider-granted creator ADMIN edge has
-- SET/INHERIT false and must remain. Temporary grants and all four owner transfers
-- are one atomic statement: failure anywhere rolls back the temporary privileges.
DO $ownership$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'allocation refs migration requires the provider postgres migration role';
  END IF;
  GRANT CREATE ON SCHEMA gymos TO gymos_refs_maint;
  GRANT gymos_refs_maint TO postgres WITH SET TRUE, INHERIT FALSE;
  ALTER FUNCTION gymos.invoice_allocation_refs_sync() OWNER TO gymos_refs_maint;
  ALTER FUNCTION gymos.invoice_allocation_refs_truncate() OWNER TO gymos_refs_maint;
  ALTER FUNCTION gymos.invoice_allocation_refs_epoch() OWNER TO gymos_refs_maint;
  ALTER FUNCTION gymos.invoice_allocation_refs_epoch_truncate() OWNER TO gymos_refs_maint;
  REVOKE gymos_refs_maint FROM postgres;
  REVOKE CREATE ON SCHEMA gymos FROM gymos_refs_maint;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE roleid='gymos_refs_maint'::regrole AND (set_option OR inherit_option))
     OR has_schema_privilege('gymos_refs_maint','gymos','CREATE') THEN
    RAISE EXCEPTION 'allocation refs maintenance-role temporary privilege cleanup failed';
  END IF;
END $ownership$;
