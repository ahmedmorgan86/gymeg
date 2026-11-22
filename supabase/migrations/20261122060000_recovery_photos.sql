SET lock_timeout='5s';
-- Restore rollback parity: a v3 restore replaces gym_photos inside one transaction. The
-- pre-restore photo set is preserved here by a SQL-side copy (never hydrated into the
-- runtime), linked to the gym_recovery row the same restore writes. Recovery core payloads
-- stay photo-free; a recovery download reads this table for its snapshot photos.
CREATE TABLE gymos.gym_recovery_photos (
 recovery_id text NOT NULL REFERENCES gymos.gym_recovery(id) ON DELETE CASCADE,
 owner_id text NOT NULL,
 member_id text NOT NULL,
 content text NOT NULL,
 PRIMARY KEY(recovery_id,member_id)
);
CREATE INDEX gym_recovery_photos_owner ON gymos.gym_recovery_photos(owner_id);
ALTER TABLE gymos.gym_recovery_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.gym_recovery_photos FORCE ROW LEVEL SECURITY;
CREATE POLICY partition_runtime ON gymos.gym_recovery_photos TO gymos_app
 USING(owner_id=current_setting('app.gym_owner',true))
 WITH CHECK(owner_id=current_setting('app.gym_owner',true));
REVOKE ALL ON gymos.gym_recovery_photos FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,DELETE ON gymos.gym_recovery_photos TO gymos_app;
