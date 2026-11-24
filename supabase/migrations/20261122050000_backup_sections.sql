SET lock_timeout='5s';
-- Backup format v3 staging: bounded sections (core + byte-capped photo/event pages) for
-- chunked download/restore. Separate from gym_backup_transfers because a v3 backup is a
-- SESSION of many sections; startTransfer wipes same-mode rows per owner+actor, which
-- would delete earlier pages of the same session. Same TTL/RLS conventions as transfers.
CREATE TABLE gymos.gym_backup_sections (
 id uuid PRIMARY KEY,
 session_id uuid NOT NULL,
 owner_id text NOT NULL,
 actor_id text NOT NULL,
 direction text NOT NULL CHECK(direction IN ('upload','download')),
 kind text NOT NULL CHECK(kind IN ('core','photos','events')),
 ordinal integer NOT NULL CHECK(ordinal >= 0),
 bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 67108864),
 digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 chunks jsonb NOT NULL DEFAULT '{}'::jsonb,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
 UNIQUE(session_id,kind,ordinal)
);
-- Durable session registry: one active session per owner+actor+direction (UNIQUE), pinned
-- revision for downloads, 30-minute TTL. Sections without a live session row are unreachable.
CREATE TABLE gymos.gym_backup_sessions (
 id uuid PRIMARY KEY,
 owner_id text NOT NULL,
 actor_id text NOT NULL,
 direction text NOT NULL CHECK(direction IN ('upload','download')),
 revision integer,
 snapshot boolean NOT NULL DEFAULT false,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes',
 UNIQUE(owner_id,actor_id,direction)
);
CREATE INDEX gym_backup_sessions_expiry ON gymos.gym_backup_sessions(expires_at);
ALTER TABLE gymos.gym_backup_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.gym_backup_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY backup_session_scope ON gymos.gym_backup_sessions TO gymos_app
 USING(owner_id=current_setting('app.gym_owner',true) AND actor_id=current_setting('app.gym_actor',true))
 WITH CHECK(owner_id=current_setting('app.gym_owner',true) AND actor_id=current_setting('app.gym_actor',true));
REVOKE ALL ON gymos.gym_backup_sessions FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON gymos.gym_backup_sessions TO gymos_app;
-- Retention minimization parity with gym_backup_transfers: the runtime role cannot delete
-- other tenants' rows under FORCE RLS, so a narrow definer function removes only rows whose
-- 30-minute TTL has already elapsed.
CREATE OR REPLACE FUNCTION gymos.cleanup_expired_backup_sections() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
DECLARE removed integer;
BEGIN
 WITH expired AS (DELETE FROM gymos.gym_backup_sections WHERE expires_at<now() RETURNING 1)
 SELECT count(*) INTO removed FROM expired;
 WITH gone AS (DELETE FROM gymos.gym_backup_sessions WHERE expires_at<now() RETURNING 1)
 SELECT removed+count(*) INTO removed FROM gone;
 RETURN removed;
END $$;
-- Owner-aggregate staged bytes across ALL actors: the runtime role's FORCE RLS is
-- actor-scoped, so admission must ask this narrow definer function. It reads only the
-- caller's own tenant (app.gym_owner GUC) and returns a byte total, nothing else.
CREATE OR REPLACE FUNCTION gymos.backup_owner_staged_bytes() RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
 SELECT COALESCE(SUM(bytes),0)::bigint FROM gymos.gym_backup_sections
 WHERE owner_id=current_setting('app.gym_owner',true) AND expires_at>now();
$$;
REVOKE ALL ON FUNCTION gymos.backup_owner_staged_bytes() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION gymos.backup_owner_staged_bytes() TO gymos_app;
REVOKE ALL ON FUNCTION gymos.cleanup_expired_backup_sections() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION gymos.cleanup_expired_backup_sections() TO gymos_app;
-- Install disabled. Enable only after the matching application release is deployed.
DO $$
BEGIN
 IF to_regnamespace('cron') IS NULL THEN RETURN; END IF;
 PERFORM gymos.cron_install_disabled('gymos-backup-section-cleanup','*/15 * * * *','SELECT gymos.cleanup_expired_backup_sections()');
END $$;
CREATE INDEX gym_backup_sections_scope ON gymos.gym_backup_sections(owner_id,actor_id,direction,expires_at);
ALTER TABLE gymos.gym_backup_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.gym_backup_sections FORCE ROW LEVEL SECURITY;
CREATE POLICY backup_section_scope ON gymos.gym_backup_sections TO gymos_app
 USING(owner_id=current_setting('app.gym_owner',true) AND actor_id=current_setting('app.gym_actor',true))
 WITH CHECK(owner_id=current_setting('app.gym_owner',true) AND actor_id=current_setting('app.gym_actor',true));
REVOKE ALL ON gymos.gym_backup_sections FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON gymos.gym_backup_sections TO gymos_app;
