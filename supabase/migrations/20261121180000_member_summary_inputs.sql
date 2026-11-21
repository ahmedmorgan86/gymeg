-- HELD DRAFT: per-member stored summary INPUTS (time-independent) with a writer-agnostic dirty queue. Not applied anywhere.
-- Exactness by construction: a trigger on gym_entities marks the affected member dirty for EVERY writer (persistSpace full and slice paths, the SQL
-- attendance auto-exit, restore, direct SQL/import). A summary row is trusted only while its member is not in the dirty queue; the reader recomputes dirty
-- members with the application's own computeStoredSummary before using them. Status, presence and debt-derived fields are derived at READ time from these
-- inputs plus settings and the clock (day rollover, policy and timezone changes need no maintenance).
-- A fresh owner is ready from creation. An existing owner stays unready (readers fall back) until gymos.backfill_member_summaries(owner) marks every member dirty.
CREATE SEQUENCE IF NOT EXISTS gymos.member_summary_gen;
CREATE TABLE IF NOT EXISTS gymos.gym_member_summaries(owner_id text NOT NULL,member_id text NOT NULL,stored jsonb NOT NULL,PRIMARY KEY(owner_id,member_id));
CREATE TABLE IF NOT EXISTS gymos.gym_member_summary_dirty(owner_id text NOT NULL,member_id text NOT NULL,gen bigint NOT NULL,PRIMARY KEY(owner_id,member_id));
CREATE TABLE IF NOT EXISTS gymos.gym_member_summary_ready(owner_id text PRIMARY KEY);
DO $rls$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['gym_member_summaries','gym_member_summary_dirty','gym_member_summary_ready'] LOOP
  EXECUTE format('ALTER TABLE gymos.%I ENABLE ROW LEVEL SECURITY',t);/* not FORCEd: definer writers run as the owner (see 20261121190000) */
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='gymos' AND tablename=t AND policyname=t||'_runtime') THEN
   EXECUTE format('CREATE POLICY %I ON gymos.%I FOR ALL TO gymos_app USING (owner_id=current_setting(''app.gym_owner'',true)) WITH CHECK (owner_id=current_setting(''app.gym_owner'',true))',t||'_runtime',t);
  END IF;
  EXECUTE format('REVOKE ALL ON gymos.%I FROM PUBLIC,anon,authenticated',t);
 END LOOP;
END $rls$;
GRANT SELECT,INSERT,UPDATE,DELETE ON gymos.gym_member_summaries TO gymos_app;
GRANT SELECT,DELETE ON gymos.gym_member_summary_dirty TO gymos_app;
GRANT SELECT ON gymos.gym_member_summary_ready TO gymos_app;

-- One trigger function per operation because the transition tables differ. Members: entity id = member id; others: payload.member (old and new rows both count).
CREATE OR REPLACE FUNCTION gymos.mark_member_summary_dirty_ins() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
BEGIN
 INSERT INTO gymos.gym_member_summary_dirty(owner_id,member_id,gen)
  SELECT owner_id,member_id,nextval('gymos.member_summary_gen') FROM (SELECT DISTINCT owner_id,CASE WHEN collection='members' THEN entity_id ELSE payload->>'member' END AS member_id FROM newrows WHERE collection IN ('members','visits','payments','invoices')) d WHERE member_id IS NOT NULL
  ON CONFLICT(owner_id,member_id) DO UPDATE SET gen=EXCLUDED.gen;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION gymos.mark_member_summary_dirty_del() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
BEGIN
 INSERT INTO gymos.gym_member_summary_dirty(owner_id,member_id,gen)
  SELECT owner_id,member_id,nextval('gymos.member_summary_gen') FROM (SELECT DISTINCT owner_id,CASE WHEN collection='members' THEN entity_id ELSE payload->>'member' END AS member_id FROM oldrows WHERE collection IN ('members','visits','payments','invoices')) d WHERE member_id IS NOT NULL
  ON CONFLICT(owner_id,member_id) DO UPDATE SET gen=EXCLUDED.gen;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION gymos.mark_member_summary_dirty_ins() FROM PUBLIC;
REVOKE ALL ON FUNCTION gymos.mark_member_summary_dirty_del() FROM PUBLIC;
CREATE OR REPLACE FUNCTION gymos.mark_member_summary_dirty_upd() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
BEGIN
 INSERT INTO gymos.gym_member_summary_dirty(owner_id,member_id,gen)
  SELECT owner_id,member_id,nextval('gymos.member_summary_gen') FROM (
   SELECT DISTINCT owner_id,member_id FROM (
    SELECT owner_id,CASE WHEN collection='members' THEN entity_id ELSE payload->>'member' END AS member_id FROM newrows WHERE collection IN ('members','visits','payments','invoices')
    UNION ALL
    SELECT owner_id,CASE WHEN collection='members' THEN entity_id ELSE payload->>'member' END FROM oldrows WHERE collection IN ('members','visits','payments','invoices')) x
   WHERE member_id IS NOT NULL) d
  ON CONFLICT(owner_id,member_id) DO UPDATE SET gen=EXCLUDED.gen;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION gymos.mark_member_summary_dirty_upd() FROM PUBLIC;
DROP TRIGGER IF EXISTS gym_entities_msum_ins ON gymos.gym_entities;
DROP TRIGGER IF EXISTS gym_entities_msum_upd ON gymos.gym_entities;
DROP TRIGGER IF EXISTS gym_entities_msum_del ON gymos.gym_entities;
CREATE TRIGGER gym_entities_msum_ins AFTER INSERT ON gymos.gym_entities REFERENCING NEW TABLE AS newrows FOR EACH STATEMENT EXECUTE FUNCTION gymos.mark_member_summary_dirty_ins();
CREATE TRIGGER gym_entities_msum_upd AFTER UPDATE ON gymos.gym_entities REFERENCING OLD TABLE AS oldrows NEW TABLE AS newrows FOR EACH STATEMENT EXECUTE FUNCTION gymos.mark_member_summary_dirty_upd();
CREATE TRIGGER gym_entities_msum_del AFTER DELETE ON gymos.gym_entities REFERENCING OLD TABLE AS oldrows FOR EACH STATEMENT EXECUTE FUNCTION gymos.mark_member_summary_dirty_del();

-- A brand-new (empty) owner is ready from creation; an owner that already has rows is not until backfill.
CREATE OR REPLACE FUNCTION gymos.mark_member_summary_ready() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
BEGIN
 DELETE FROM gymos.gym_member_summaries WHERE owner_id=NEW.user_id;DELETE FROM gymos.gym_member_summary_dirty WHERE owner_id=NEW.user_id;DELETE FROM gymos.gym_member_summary_ready WHERE owner_id=NEW.user_id;
 IF NOT EXISTS(SELECT 1 FROM gymos.gym_entities WHERE owner_id=NEW.user_id LIMIT 1) THEN INSERT INTO gymos.gym_member_summary_ready(owner_id) VALUES(NEW.user_id); END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION gymos.mark_member_summary_ready() FROM PUBLIC;
DROP TRIGGER IF EXISTS gym_states_msum_ready ON gymos.gym_states;
CREATE TRIGGER gym_states_msum_ready AFTER INSERT ON gymos.gym_states FOR EACH ROW EXECUTE FUNCTION gymos.mark_member_summary_ready();

-- Separately gated backfill for an existing owner: every member becomes dirty (the reader computes them), then the owner is ready.
CREATE OR REPLACE FUNCTION gymos.backfill_member_summaries(target text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
BEGIN
 PERFORM 1 FROM gymos.gym_states WHERE user_id=target FOR UPDATE;
 DELETE FROM gymos.gym_member_summaries WHERE owner_id=target;DELETE FROM gymos.gym_member_summary_dirty WHERE owner_id=target;
 INSERT INTO gymos.gym_member_summary_dirty(owner_id,member_id,gen) SELECT owner_id,entity_id,nextval('gymos.member_summary_gen') FROM gymos.gym_entities WHERE owner_id=target AND collection='members';
 INSERT INTO gymos.gym_member_summary_ready(owner_id) VALUES(target) ON CONFLICT DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION gymos.backfill_member_summaries(text) FROM PUBLIC;

-- TRUNCATE of gym_entities has no owner: drop every owner's readiness and rows so readers fall back until backfill is run again.
CREATE OR REPLACE FUNCTION gymos.reset_member_summaries() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
BEGIN DELETE FROM gymos.gym_member_summary_ready;DELETE FROM gymos.gym_member_summaries;DELETE FROM gymos.gym_member_summary_dirty; RETURN NULL; END $$;
REVOKE ALL ON FUNCTION gymos.reset_member_summaries() FROM PUBLIC;
DROP TRIGGER IF EXISTS gym_entities_msum_trunc ON gymos.gym_entities;
CREATE TRIGGER gym_entities_msum_trunc AFTER TRUNCATE ON gymos.gym_entities FOR EACH STATEMENT EXECUTE FUNCTION gymos.reset_member_summaries();
