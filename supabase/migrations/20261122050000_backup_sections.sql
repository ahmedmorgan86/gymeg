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
CREATE INDEX gym_backup_sections_scope ON gymos.gym_backup_sections(owner_id,actor_id,direction,expires_at);
ALTER TABLE gymos.gym_backup_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.gym_backup_sections FORCE ROW LEVEL SECURITY;
CREATE POLICY backup_section_scope ON gymos.gym_backup_sections TO gymos_app
 USING(owner_id=current_setting('app.gym_owner',true) AND actor_id=current_setting('app.gym_actor',true))
 WITH CHECK(owner_id=current_setting('app.gym_owner',true) AND actor_id=current_setting('app.gym_actor',true));
REVOKE ALL ON gymos.gym_backup_sections FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON gymos.gym_backup_sections TO gymos_app;
