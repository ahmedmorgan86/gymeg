SET lock_timeout='5s';
-- Restore rollback parity: a v3 restore replaces gym_photos inside one transaction. The
-- pre-restore photo set is preserved here by a SQL-side copy (never hydrated into the
-- runtime), linked to the gym_recovery row the same restore writes. Recovery core payloads
-- stay photo-free; a recovery download reads this table for its snapshot photos.
-- The FK binds (recovery_id, owner_id) COMPOSITELY: a runtime-role session scoped to one
-- owner can never reference another owner's recovery row, even with a known id.
CREATE UNIQUE INDEX IF NOT EXISTS gym_recovery_id_owner ON gymos.gym_recovery(id,owner_id);
CREATE TABLE gymos.gym_recovery_photos (
 recovery_id text NOT NULL,
 owner_id text NOT NULL,
 member_id text NOT NULL,
 content text NOT NULL,
 PRIMARY KEY(recovery_id,member_id),
 FOREIGN KEY(recovery_id,owner_id) REFERENCES gymos.gym_recovery(id,owner_id) ON DELETE CASCADE
);
CREATE INDEX gym_recovery_photos_owner ON gymos.gym_recovery_photos(owner_id);
ALTER TABLE gymos.gym_recovery_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.gym_recovery_photos FORCE ROW LEVEL SECURITY;
CREATE POLICY partition_runtime ON gymos.gym_recovery_photos TO gymos_app
 USING(owner_id=current_setting('app.gym_owner',true))
 WITH CHECK(owner_id=current_setting('app.gym_owner',true));
REVOKE ALL ON gymos.gym_recovery_photos FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,DELETE ON gymos.gym_recovery_photos TO gymos_app;
