-- HELD DRAFT: a per-owner change version that moves for EVERY writer. A cached candidate set (member rows + stored summary inputs) may be reused only while this
-- token is unchanged. Statement-level triggers on gym_entities (insert/update/delete) and row-level triggers on gym_states (insert/update/delete) set the owner's
-- version to nextval of ONE global sequence, so it is strictly increasing across all writers (persistSpace full and slice paths, SQL auto-exit, restore, direct
-- SQL/import, settings and plan changes in gym_states) and never repeats, even after a TRUNCATE (which empties the table: a missing token never matches).
-- Trigger names sort AFTER the counters (gym_entities_counter_*) and summary-mark (gym_entities_msum_*) triggers, so a writer takes the counters row first, as before.
-- Not applied anywhere.
CREATE SEQUENCE IF NOT EXISTS gymos.gym_change_seq;
CREATE TABLE IF NOT EXISTS gymos.gym_owner_version(owner_id text PRIMARY KEY,version bigint NOT NULL);
-- RLS is enabled but NOT forced: the SECURITY DEFINER writers run as the table owner, and a forced policy would make every club write fail unless that owner has BYPASSRLS (proved on PG16 with a NOSUPERUSER NOBYPASSRLS owner). gymos_app is not the owner, so its SELECT policy applies.
ALTER TABLE gymos.gym_owner_version ENABLE ROW LEVEL SECURITY;
DO $p$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='gymos' AND tablename='gym_owner_version' AND policyname='gym_owner_version_runtime') THEN
 CREATE POLICY gym_owner_version_runtime ON gymos.gym_owner_version FOR SELECT TO gymos_app USING (owner_id=current_setting('app.gym_owner',true)); END IF; END $p$;
REVOKE ALL ON gymos.gym_owner_version FROM PUBLIC,anon,authenticated;
GRANT SELECT ON gymos.gym_owner_version TO gymos_app;

CREATE OR REPLACE FUNCTION gymos.bump_owner_version_ins() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
BEGIN
 INSERT INTO gymos.gym_owner_version(owner_id,version) SELECT owner_id,nextval('gymos.gym_change_seq') FROM (SELECT DISTINCT owner_id FROM newrows ORDER BY owner_id) o
  ON CONFLICT(owner_id) DO UPDATE SET version=EXCLUDED.version;RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION gymos.bump_owner_version_del() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
BEGIN
 INSERT INTO gymos.gym_owner_version(owner_id,version) SELECT owner_id,nextval('gymos.gym_change_seq') FROM (SELECT DISTINCT owner_id FROM oldrows ORDER BY owner_id) o
  ON CONFLICT(owner_id) DO UPDATE SET version=EXCLUDED.version;RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION gymos.bump_owner_version_upd() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
BEGIN
 INSERT INTO gymos.gym_owner_version(owner_id,version) SELECT owner_id,nextval('gymos.gym_change_seq') FROM (SELECT owner_id FROM newrows UNION SELECT owner_id FROM oldrows ORDER BY 1) o
  ON CONFLICT(owner_id) DO UPDATE SET version=EXCLUDED.version;RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION gymos.bump_owner_version_state() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
DECLARE o text:=COALESCE(NEW.user_id,OLD.user_id);
BEGIN
 INSERT INTO gymos.gym_owner_version(owner_id,version) VALUES(o,nextval('gymos.gym_change_seq')) ON CONFLICT(owner_id) DO UPDATE SET version=EXCLUDED.version;RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION gymos.reset_owner_version() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
BEGIN DELETE FROM gymos.gym_owner_version;RETURN NULL;END $$;
REVOKE ALL ON FUNCTION gymos.bump_owner_version_ins() FROM PUBLIC;REVOKE ALL ON FUNCTION gymos.bump_owner_version_del() FROM PUBLIC;REVOKE ALL ON FUNCTION gymos.bump_owner_version_upd() FROM PUBLIC;
REVOKE ALL ON FUNCTION gymos.bump_owner_version_state() FROM PUBLIC;REVOKE ALL ON FUNCTION gymos.reset_owner_version() FROM PUBLIC;
DROP TRIGGER IF EXISTS gym_entities_zver_ins ON gymos.gym_entities;DROP TRIGGER IF EXISTS gym_entities_zver_upd ON gymos.gym_entities;DROP TRIGGER IF EXISTS gym_entities_zver_del ON gymos.gym_entities;DROP TRIGGER IF EXISTS gym_entities_zver_trunc ON gymos.gym_entities;
CREATE TRIGGER gym_entities_zver_ins AFTER INSERT ON gymos.gym_entities REFERENCING NEW TABLE AS newrows FOR EACH STATEMENT EXECUTE FUNCTION gymos.bump_owner_version_ins();
CREATE TRIGGER gym_entities_zver_upd AFTER UPDATE ON gymos.gym_entities REFERENCING OLD TABLE AS oldrows NEW TABLE AS newrows FOR EACH STATEMENT EXECUTE FUNCTION gymos.bump_owner_version_upd();
CREATE TRIGGER gym_entities_zver_del AFTER DELETE ON gymos.gym_entities REFERENCING OLD TABLE AS oldrows FOR EACH STATEMENT EXECUTE FUNCTION gymos.bump_owner_version_del();
CREATE TRIGGER gym_entities_zver_trunc AFTER TRUNCATE ON gymos.gym_entities FOR EACH STATEMENT EXECUTE FUNCTION gymos.reset_owner_version();
DROP TRIGGER IF EXISTS gym_states_zver ON gymos.gym_states;DROP TRIGGER IF EXISTS gym_states_zver_trunc ON gymos.gym_states;
CREATE TRIGGER gym_states_zver AFTER INSERT OR UPDATE OR DELETE ON gymos.gym_states FOR EACH ROW EXECUTE FUNCTION gymos.bump_owner_version_state();
CREATE TRIGGER gym_states_zver_trunc AFTER TRUNCATE ON gymos.gym_states FOR EACH STATEMENT EXECUTE FUNCTION gymos.reset_owner_version();
-- Member photo rows live in gym_photos: candidate rows carry the photo version (hash), so a photo change must move the token too.
DROP TRIGGER IF EXISTS gym_photos_zver_ins ON gymos.gym_photos;DROP TRIGGER IF EXISTS gym_photos_zver_upd ON gymos.gym_photos;DROP TRIGGER IF EXISTS gym_photos_zver_del ON gymos.gym_photos;DROP TRIGGER IF EXISTS gym_photos_zver_trunc ON gymos.gym_photos;
CREATE TRIGGER gym_photos_zver_ins AFTER INSERT ON gymos.gym_photos REFERENCING NEW TABLE AS newrows FOR EACH STATEMENT EXECUTE FUNCTION gymos.bump_owner_version_ins();
CREATE TRIGGER gym_photos_zver_upd AFTER UPDATE ON gymos.gym_photos REFERENCING OLD TABLE AS oldrows NEW TABLE AS newrows FOR EACH STATEMENT EXECUTE FUNCTION gymos.bump_owner_version_upd();
CREATE TRIGGER gym_photos_zver_del AFTER DELETE ON gymos.gym_photos REFERENCING OLD TABLE AS oldrows FOR EACH STATEMENT EXECUTE FUNCTION gymos.bump_owner_version_del();
CREATE TRIGGER gym_photos_zver_trunc AFTER TRUNCATE ON gymos.gym_photos FOR EACH STATEMENT EXECUTE FUNCTION gymos.reset_owner_version();
