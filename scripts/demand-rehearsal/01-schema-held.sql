-- HELD CANDIDATE. GENERATED SOURCE FOR REVIEW/ISOLATED REHEARSAL ONLY. NOT PRODUCTION APPROVAL.
BEGIN;
SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='15s';
-- HELD DRAFT: maintained per-owner row counts and a safe upper bound of serialized bytes, kept by triggers so EVERY writer is covered
-- (persistSpace full and slice paths, the SQL attendance auto-exit, restore, direct SQL) inside the writer's own transaction.
-- Not applied anywhere. A fresh target needs no backfill: an owner's marker row is created with the owner. Existing owners stay on count(*) until
-- gymos.recount_entity_counters(owner) has been run (separately gated).
-- payload_bytes uses octet_length(jsonb::text). jsonb text adds a space after ':' and ',' and spells numbers out, so it is >= the compact JSON.stringify
-- length of the same value: a safe upper bound, never an exact size. The route's 20,000,000-byte rule stays exact on the full path.
CREATE TABLE IF NOT EXISTS gymos.gym_entity_counters(
 owner_id text NOT NULL,
 collection text NOT NULL, -- an entity collection, 'photos', or the marker '_ready'
 row_count bigint NOT NULL DEFAULT 0,
 payload_bytes bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(owner_id,collection)
);

ALTER TABLE gymos.gym_entity_counters ENABLE ROW LEVEL SECURITY;

ALTER TABLE gymos.gym_entity_counters FORCE ROW LEVEL SECURITY;

DO $policy$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='gymos' AND tablename='gym_entity_counters' AND policyname='gym_entity_counters_runtime') THEN
 CREATE POLICY gym_entity_counters_runtime ON gymos.gym_entity_counters FOR SELECT TO gymos_app USING (owner_id=current_setting('app.gym_owner',true)); END IF; END $policy$;

REVOKE ALL ON gymos.gym_entity_counters FROM PUBLIC,anon,authenticated;

GRANT SELECT ON gymos.gym_entity_counters TO gymos_app;

CREATE OR REPLACE FUNCTION gymos.apply_entity_counter_delta() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
BEGIN
 -- Statement-level: one aggregate per owner and collection. TG_ARGV[0] selects the table family.
 IF TG_ARGV[0]='entities' THEN
  IF TG_OP='INSERT' THEN
   INSERT INTO gymos.gym_entity_counters(owner_id,collection,row_count,payload_bytes) SELECT owner_id,collection,count(*),sum(octet_length(payload::text)) FROM newrows GROUP BY 1,2
   ON CONFLICT(owner_id,collection) DO UPDATE SET row_count=gym_entity_counters.row_count+EXCLUDED.row_count,payload_bytes=gym_entity_counters.payload_bytes+EXCLUDED.payload_bytes;
  ELSIF TG_OP='DELETE' THEN
   INSERT INTO gymos.gym_entity_counters(owner_id,collection,row_count,payload_bytes) SELECT owner_id,collection,-count(*),-sum(octet_length(payload::text)) FROM oldrows GROUP BY 1,2
   ON CONFLICT(owner_id,collection) DO UPDATE SET row_count=gym_entity_counters.row_count+EXCLUDED.row_count,payload_bytes=gym_entity_counters.payload_bytes+EXCLUDED.payload_bytes;
  ELSE
   INSERT INTO gymos.gym_entity_counters(owner_id,collection,row_count,payload_bytes)
    SELECT owner_id,collection,sum(c),sum(b) FROM (SELECT owner_id,collection,1 AS c,octet_length(payload::text) AS b FROM newrows UNION ALL SELECT owner_id,collection,-1,-octet_length(payload::text) FROM oldrows) d GROUP BY 1,2
   ON CONFLICT(owner_id,collection) DO UPDATE SET row_count=gym_entity_counters.row_count+EXCLUDED.row_count,payload_bytes=gym_entity_counters.payload_bytes+EXCLUDED.payload_bytes;
  END IF;
 ELSE
  -- photos: the full state carries each photo inside its member as "photo":<json string>
  IF TG_OP='INSERT' THEN
   INSERT INTO gymos.gym_entity_counters(owner_id,collection,row_count,payload_bytes) SELECT owner_id,'photos',count(*),sum(octet_length(to_jsonb(content)::text)+9) FROM newrows GROUP BY 1
   ON CONFLICT(owner_id,collection) DO UPDATE SET row_count=gym_entity_counters.row_count+EXCLUDED.row_count,payload_bytes=gym_entity_counters.payload_bytes+EXCLUDED.payload_bytes;
  ELSIF TG_OP='DELETE' THEN
   INSERT INTO gymos.gym_entity_counters(owner_id,collection,row_count,payload_bytes) SELECT owner_id,'photos',-count(*),-sum(octet_length(to_jsonb(content)::text)+9) FROM oldrows GROUP BY 1
   ON CONFLICT(owner_id,collection) DO UPDATE SET row_count=gym_entity_counters.row_count+EXCLUDED.row_count,payload_bytes=gym_entity_counters.payload_bytes+EXCLUDED.payload_bytes;
  ELSE
   INSERT INTO gymos.gym_entity_counters(owner_id,collection,row_count,payload_bytes)
    SELECT owner_id,'photos',sum(c),sum(b) FROM (SELECT owner_id,1 AS c,octet_length(to_jsonb(content)::text)+9 AS b FROM newrows UNION ALL SELECT owner_id,-1,-(octet_length(to_jsonb(content)::text)+9) FROM oldrows) d GROUP BY 1
   ON CONFLICT(owner_id,collection) DO UPDATE SET row_count=gym_entity_counters.row_count+EXCLUDED.row_count,payload_bytes=gym_entity_counters.payload_bytes+EXCLUDED.payload_bytes;
  END IF;
 END IF;
 RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION gymos.apply_entity_counter_delta() FROM PUBLIC;

DROP TRIGGER IF EXISTS gym_entities_counter_ins ON gymos.gym_entities;

DROP TRIGGER IF EXISTS gym_entities_counter_upd ON gymos.gym_entities;

DROP TRIGGER IF EXISTS gym_entities_counter_del ON gymos.gym_entities;

CREATE TRIGGER gym_entities_counter_ins AFTER INSERT ON gymos.gym_entities REFERENCING NEW TABLE AS newrows FOR EACH STATEMENT EXECUTE FUNCTION gymos.apply_entity_counter_delta('entities');

CREATE TRIGGER gym_entities_counter_upd AFTER UPDATE ON gymos.gym_entities REFERENCING OLD TABLE AS oldrows NEW TABLE AS newrows FOR EACH STATEMENT EXECUTE FUNCTION gymos.apply_entity_counter_delta('entities');

CREATE TRIGGER gym_entities_counter_del AFTER DELETE ON gymos.gym_entities REFERENCING OLD TABLE AS oldrows FOR EACH STATEMENT EXECUTE FUNCTION gymos.apply_entity_counter_delta('entities');

DROP TRIGGER IF EXISTS gym_photos_counter_ins ON gymos.gym_photos;

DROP TRIGGER IF EXISTS gym_photos_counter_upd ON gymos.gym_photos;

DROP TRIGGER IF EXISTS gym_photos_counter_del ON gymos.gym_photos;

CREATE TRIGGER gym_photos_counter_ins AFTER INSERT ON gymos.gym_photos REFERENCING NEW TABLE AS newrows FOR EACH STATEMENT EXECUTE FUNCTION gymos.apply_entity_counter_delta('photos');

CREATE TRIGGER gym_photos_counter_upd AFTER UPDATE ON gymos.gym_photos REFERENCING OLD TABLE AS oldrows NEW TABLE AS newrows FOR EACH STATEMENT EXECUTE FUNCTION gymos.apply_entity_counter_delta('photos');

CREATE TRIGGER gym_photos_counter_del AFTER DELETE ON gymos.gym_photos REFERENCING OLD TABLE AS oldrows FOR EACH STATEMENT EXECUTE FUNCTION gymos.apply_entity_counter_delta('photos');

-- A brand-new owner has no rows, so its counters are exact from the start.
CREATE OR REPLACE FUNCTION gymos.mark_counters_ready() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM gymos.gym_entities WHERE owner_id=NEW.user_id LIMIT 1) AND NOT EXISTS(SELECT 1 FROM gymos.gym_photos WHERE owner_id=NEW.user_id LIMIT 1) THEN
  -- An empty owner starts from zero: drop any leftover deltas (an owner deleted and recreated) in the same statement before marking ready.
  DELETE FROM gymos.gym_entity_counters WHERE owner_id=NEW.user_id;
  INSERT INTO gymos.gym_entity_counters(owner_id,collection) VALUES(NEW.user_id,'_ready');
 ELSE
  DELETE FROM gymos.gym_entity_counters WHERE owner_id=NEW.user_id AND collection='_ready'; -- rows already exist: never trust, until recount
 END IF; RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION gymos.mark_counters_ready() FROM PUBLIC;

DROP TRIGGER IF EXISTS gym_states_counters_ready ON gymos.gym_states;

CREATE TRIGGER gym_states_counters_ready AFTER INSERT ON gymos.gym_states FOR EACH ROW EXECUTE FUNCTION gymos.mark_counters_ready();

-- Verification and (separately gated) backfill for an existing owner: recompute from the rows, then mark ready. Not run by this migration.
CREATE OR REPLACE FUNCTION gymos.recount_entity_counters(target text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
BEGIN
 PERFORM 1 FROM gymos.gym_states WHERE user_id=target FOR UPDATE; -- serialize against persistSpace for this owner
 DELETE FROM gymos.gym_entity_counters WHERE owner_id=target;
 INSERT INTO gymos.gym_entity_counters(owner_id,collection,row_count,payload_bytes) SELECT owner_id,collection,count(*),sum(octet_length(payload::text)) FROM gymos.gym_entities WHERE owner_id=target GROUP BY 1,2;
 INSERT INTO gymos.gym_entity_counters(owner_id,collection,row_count,payload_bytes) SELECT owner_id,'photos',count(*),sum(octet_length(to_jsonb(content)::text)+9) FROM gymos.gym_photos WHERE owner_id=target GROUP BY 1;
 INSERT INTO gymos.gym_entity_counters(owner_id,collection) VALUES(target,'_ready');
END $$;

REVOKE ALL ON FUNCTION gymos.recount_entity_counters(text) FROM PUBLIC;

-- TRUNCATE has no transition tables and no owner. Any truncate of either table drops every owner's counters and markers, so counts and the size
-- bound go back to count(*) / the full path until recount_entity_counters(owner) is run again. It can never leave a silently wrong counter.
CREATE OR REPLACE FUNCTION gymos.reset_entity_counters() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
BEGIN DELETE FROM gymos.gym_entity_counters; RETURN NULL; END $$;

REVOKE ALL ON FUNCTION gymos.reset_entity_counters() FROM PUBLIC;

DROP TRIGGER IF EXISTS gym_entities_counter_trunc ON gymos.gym_entities;

DROP TRIGGER IF EXISTS gym_photos_counter_trunc ON gymos.gym_photos;

CREATE TRIGGER gym_entities_counter_trunc AFTER TRUNCATE ON gymos.gym_entities FOR EACH STATEMENT EXECUTE FUNCTION gymos.reset_entity_counters();

CREATE TRIGGER gym_photos_counter_trunc AFTER TRUNCATE ON gymos.gym_photos FOR EACH STATEMENT EXECUTE FUNCTION gymos.reset_entity_counters();

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
  EXECUTE format('ALTER TABLE gymos.%I ENABLE ROW LEVEL SECURITY',t);EXECUTE format('ALTER TABLE gymos.%I FORCE ROW LEVEL SECURITY',t);
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='gymos' AND tablename=t AND policyname=t||'_runtime') THEN
   EXECUTE format('CREATE POLICY %I ON gymos.%I FOR ALL TO gymos_app USING (owner_id=current_setting(''app.gym_owner'',true)) WITH CHECK (owner_id=current_setting(''app.gym_owner'',true))',t||'_runtime',t);
  END IF;
  EXECUTE format('REVOKE ALL ON gymos.%I FROM PUBLIC,anon,authenticated',t);
 END LOOP;
END $rls$;

GRANT SELECT,INSERT,UPDATE,DELETE ON gymos.gym_member_summaries TO gymos_app;

GRANT SELECT,DELETE ON gymos.gym_member_summary_dirty TO gymos_app;

GRANT SELECT ON gymos.gym_member_summary_ready TO gymos_app;

-- Member keys longer than 1024 bytes cannot be keys of the summary tables (btree row limit; the legacy state rules accept any length). Such a write is NEVER rejected: the owner simply loses readiness
-- (readers use the exact legacy paths) and the oversized key is not queued. 1024 bytes is an index-eligibility threshold chosen under the ~2.7 KB btree key limit, not a product limit.
CREATE OR REPLACE FUNCTION gymos.msum_oversize(k text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT octet_length(k)>1024 $$;

-- One trigger function per operation because the transition tables differ. Members: entity id = member id; others: payload.member (old and new rows both count).
CREATE OR REPLACE FUNCTION gymos.mark_member_summary_dirty_ins() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
BEGIN
 DELETE FROM gymos.gym_member_summary_ready WHERE owner_id IN (SELECT owner_id FROM newrows WHERE collection IN ('members','visits','payments','invoices') AND gymos.msum_oversize(CASE WHEN collection='members' THEN entity_id ELSE payload->>'member' END));
 INSERT INTO gymos.gym_member_summary_dirty(owner_id,member_id,gen)
  SELECT owner_id,member_id,nextval('gymos.member_summary_gen') FROM (SELECT DISTINCT owner_id,CASE WHEN collection='members' THEN entity_id ELSE payload->>'member' END AS member_id FROM newrows WHERE collection IN ('members','visits','payments','invoices')) d WHERE member_id IS NOT NULL AND NOT gymos.msum_oversize(member_id)
  ON CONFLICT(owner_id,member_id) DO UPDATE SET gen=EXCLUDED.gen;
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION gymos.mark_member_summary_dirty_del() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
BEGIN
 DELETE FROM gymos.gym_member_summary_ready WHERE owner_id IN (SELECT owner_id FROM oldrows WHERE collection IN ('members','visits','payments','invoices') AND gymos.msum_oversize(CASE WHEN collection='members' THEN entity_id ELSE payload->>'member' END));
 INSERT INTO gymos.gym_member_summary_dirty(owner_id,member_id,gen)
  SELECT owner_id,member_id,nextval('gymos.member_summary_gen') FROM (SELECT DISTINCT owner_id,CASE WHEN collection='members' THEN entity_id ELSE payload->>'member' END AS member_id FROM oldrows WHERE collection IN ('members','visits','payments','invoices')) d WHERE member_id IS NOT NULL AND NOT gymos.msum_oversize(member_id)
  ON CONFLICT(owner_id,member_id) DO UPDATE SET gen=EXCLUDED.gen;
 RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION gymos.mark_member_summary_dirty_ins() FROM PUBLIC;

REVOKE ALL ON FUNCTION gymos.mark_member_summary_dirty_del() FROM PUBLIC;

CREATE OR REPLACE FUNCTION gymos.mark_member_summary_dirty_upd() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
BEGIN
 DELETE FROM gymos.gym_member_summary_ready WHERE owner_id IN (SELECT owner_id FROM newrows WHERE collection IN ('members','visits','payments','invoices') AND gymos.msum_oversize(CASE WHEN collection='members' THEN entity_id ELSE payload->>'member' END));
 INSERT INTO gymos.gym_member_summary_dirty(owner_id,member_id,gen)
  SELECT owner_id,member_id,nextval('gymos.member_summary_gen') FROM (
   SELECT DISTINCT owner_id,member_id FROM (
    SELECT owner_id,CASE WHEN collection='members' THEN entity_id ELSE payload->>'member' END AS member_id FROM newrows WHERE collection IN ('members','visits','payments','invoices')
    UNION ALL
    SELECT owner_id,CASE WHEN collection='members' THEN entity_id ELSE payload->>'member' END FROM oldrows WHERE collection IN ('members','visits','payments','invoices')) x
   WHERE member_id IS NOT NULL AND NOT gymos.msum_oversize(member_id)) d
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
 INSERT INTO gymos.gym_member_summary_dirty(owner_id,member_id,gen) SELECT owner_id,entity_id,nextval('gymos.member_summary_gen') FROM gymos.gym_entities WHERE owner_id=target AND collection='members' AND NOT gymos.msum_oversize(entity_id);
 -- ready only when no member key of the owner is oversized; otherwise readers keep the exact legacy paths
 IF NOT EXISTS(SELECT 1 FROM gymos.gym_entities WHERE owner_id=target AND collection IN ('members','visits','payments','invoices') AND gymos.msum_oversize(CASE WHEN collection='members' THEN entity_id ELSE payload->>'member' END)) THEN INSERT INTO gymos.gym_member_summary_ready(owner_id) VALUES(target) ON CONFLICT DO NOTHING; END IF;
END $$;

REVOKE ALL ON FUNCTION gymos.backfill_member_summaries(text) FROM PUBLIC;

-- TRUNCATE of gym_entities has no owner: drop every owner's readiness and rows so readers fall back until backfill is run again.
CREATE OR REPLACE FUNCTION gymos.reset_member_summaries() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
BEGIN DELETE FROM gymos.gym_member_summary_ready;DELETE FROM gymos.gym_member_summaries;DELETE FROM gymos.gym_member_summary_dirty; RETURN NULL; END $$;

REVOKE ALL ON FUNCTION gymos.reset_member_summaries() FROM PUBLIC;

DROP TRIGGER IF EXISTS gym_entities_msum_trunc ON gymos.gym_entities;

CREATE TRIGGER gym_entities_msum_trunc AFTER TRUNCATE ON gymos.gym_entities FOR EACH STATEMENT EXECUTE FUNCTION gymos.reset_member_summaries();

-- HELD DRAFT: a per-owner change version that moves for EVERY writer. A cached candidate set (member rows + stored summary inputs) may be reused only while this
-- token is unchanged. Statement-level triggers on gym_entities (insert/update/delete) and row-level triggers on gym_states (insert/update/delete) set the owner's
-- version to nextval of ONE global sequence, so it is strictly increasing across all writers (persistSpace full and slice paths, SQL auto-exit, restore, direct
-- SQL/import, settings and plan changes in gym_states) and never repeats, even after a TRUNCATE (which empties the table: a missing token never matches).
-- Trigger names sort AFTER the counters (gym_entities_counter_*) and summary-mark (gym_entities_msum_*) triggers, so a writer takes the counters row first, as before.
-- Not applied anywhere.
CREATE SEQUENCE IF NOT EXISTS gymos.gym_change_seq;

CREATE TABLE IF NOT EXISTS gymos.gym_owner_version(owner_id text PRIMARY KEY,version bigint NOT NULL);

-- FORCE RLS like the other tables. The SECURITY DEFINER writers run as the migration/table owner, which must have BYPASSRLS (true for the target `postgres` role; gymos_app is NOSUPERUSER NOBYPASSRLS and owns nothing, so its SELECT policy applies).
ALTER TABLE gymos.gym_owner_version ENABLE ROW LEVEL SECURITY;

ALTER TABLE gymos.gym_owner_version FORCE ROW LEVEL SECURITY;

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

REVOKE ALL ON FUNCTION gymos.bump_owner_version_ins() FROM PUBLIC;

REVOKE ALL ON FUNCTION gymos.bump_owner_version_del() FROM PUBLIC;

REVOKE ALL ON FUNCTION gymos.bump_owner_version_upd() FROM PUBLIC;

REVOKE ALL ON FUNCTION gymos.bump_owner_version_state() FROM PUBLIC;

REVOKE ALL ON FUNCTION gymos.reset_owner_version() FROM PUBLIC;

DROP TRIGGER IF EXISTS gym_entities_zver_ins ON gymos.gym_entities;

DROP TRIGGER IF EXISTS gym_entities_zver_upd ON gymos.gym_entities;

DROP TRIGGER IF EXISTS gym_entities_zver_del ON gymos.gym_entities;

DROP TRIGGER IF EXISTS gym_entities_zver_trunc ON gymos.gym_entities;

CREATE TRIGGER gym_entities_zver_ins AFTER INSERT ON gymos.gym_entities REFERENCING NEW TABLE AS newrows FOR EACH STATEMENT EXECUTE FUNCTION gymos.bump_owner_version_ins();

CREATE TRIGGER gym_entities_zver_upd AFTER UPDATE ON gymos.gym_entities REFERENCING OLD TABLE AS oldrows NEW TABLE AS newrows FOR EACH STATEMENT EXECUTE FUNCTION gymos.bump_owner_version_upd();

CREATE TRIGGER gym_entities_zver_del AFTER DELETE ON gymos.gym_entities REFERENCING OLD TABLE AS oldrows FOR EACH STATEMENT EXECUTE FUNCTION gymos.bump_owner_version_del();

CREATE TRIGGER gym_entities_zver_trunc AFTER TRUNCATE ON gymos.gym_entities FOR EACH STATEMENT EXECUTE FUNCTION gymos.reset_owner_version();

DROP TRIGGER IF EXISTS gym_states_zver ON gymos.gym_states;

DROP TRIGGER IF EXISTS gym_states_zver_trunc ON gymos.gym_states;

CREATE TRIGGER gym_states_zver AFTER INSERT OR UPDATE OR DELETE ON gymos.gym_states FOR EACH ROW EXECUTE FUNCTION gymos.bump_owner_version_state();

CREATE TRIGGER gym_states_zver_trunc AFTER TRUNCATE ON gymos.gym_states FOR EACH STATEMENT EXECUTE FUNCTION gymos.reset_owner_version();

-- Member photo rows live in gym_photos: candidate rows carry the photo version (hash), so a photo change must move the token too.
DROP TRIGGER IF EXISTS gym_photos_zver_ins ON gymos.gym_photos;

DROP TRIGGER IF EXISTS gym_photos_zver_upd ON gymos.gym_photos;

DROP TRIGGER IF EXISTS gym_photos_zver_del ON gymos.gym_photos;

DROP TRIGGER IF EXISTS gym_photos_zver_trunc ON gymos.gym_photos;

CREATE TRIGGER gym_photos_zver_ins AFTER INSERT ON gymos.gym_photos REFERENCING NEW TABLE AS newrows FOR EACH STATEMENT EXECUTE FUNCTION gymos.bump_owner_version_ins();

CREATE TRIGGER gym_photos_zver_upd AFTER UPDATE ON gymos.gym_photos REFERENCING OLD TABLE AS oldrows NEW TABLE AS newrows FOR EACH STATEMENT EXECUTE FUNCTION gymos.bump_owner_version_upd();

CREATE TRIGGER gym_photos_zver_del AFTER DELETE ON gymos.gym_photos REFERENCING OLD TABLE AS oldrows FOR EACH STATEMENT EXECUTE FUNCTION gymos.bump_owner_version_del();

CREATE TRIGGER gym_photos_zver_trunc AFTER TRUNCATE ON gymos.gym_photos FOR EACH STATEMENT EXECUTE FUNCTION gymos.reset_owner_version();

-- HELD DRAFT. Exact canonical UTC visit-clock detection, conservative for old
-- malformed timestamps. Invalid dates return false rather than block a write.
CREATE OR REPLACE FUNCTION gymos.canonical_visit_clock(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL UNSAFE AS $$
DECLARE t text;
BEGIN
 IF jsonb_typeof(COALESCE(NULLIF(p->'activeAt','null'::jsonb),p->'at')) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
 t=COALESCE(p->>'activeAt',p->>'at');
 IF t !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$' THEN RETURN false; END IF;
 RETURN to_char(t::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=t;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;

-- HELD DRAFT. Ordinary generated keys allow runtime FORCE-RLS plans to use
-- member/range index conditions. Expression keys alone are not sufficient:
-- JSON extraction is not leakproof, so it stays above the RLS security barrier.
-- No role, policy, function-security or LEAKPROOF changes.
-- ALTER TABLE rewrites/backfills existing rows under a lock. Production rollout
-- needs separately reviewed maintenance/concurrent-index planning. Not applied.
-- The exception-catching calendar validator opens a subtransaction. It must
-- never run in a parallel worker, including a generated-column backfill.
ALTER FUNCTION gymos.canonical_visit_clock(jsonb) PARALLEL UNSAFE;

ALTER TABLE gymos.gym_entities
 ADD COLUMN demand_member_hash text GENERATED ALWAYS AS
  (CASE WHEN jsonb_typeof(payload->'member')='string' THEN md5(payload->>'member') END) STORED,
 ADD COLUMN demand_visit_day text COLLATE "C" GENERATED ALWAYS AS
  (CASE WHEN collection='visits' AND jsonb_typeof(payload->'day')='string'
    AND payload->>'day' ~ '^\d{4}-\d\d-\d\d$' THEN payload->>'day' END) STORED,
 ADD COLUMN demand_visit_clock text COLLATE "C" GENERATED ALWAYS AS
  (CASE WHEN collection='visits' AND gymos.canonical_visit_clock(payload)
    THEN COALESCE(payload->>'activeAt',payload->>'at') END) STORED,
 ADD COLUMN IF NOT EXISTS pay_day text COLLATE "C" GENERATED ALWAYS AS (CASE WHEN collection='payments' AND jsonb_typeof(payload->'day')='string' AND payload->>'day' ~ '^\d{4}-\d\d-\d\d$' THEN payload->>'day' END) STORED,
  ADD COLUMN IF NOT EXISTS pay_day_odd boolean GENERATED ALWAYS AS (collection='payments' AND NOT COALESCE(jsonb_typeof(payload->'day')='string' AND payload->>'day' ~ '^\d{4}-\d\d-\d\d$',false)) STORED,
  ADD COLUMN IF NOT EXISTS visit_at text COLLATE "C" GENERATED ALWAYS AS (CASE WHEN collection='visits' AND jsonb_typeof(payload->'at')='string' AND payload->>'at' ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$' THEN payload->>'at' END) STORED,
  ADD COLUMN IF NOT EXISTS visit_odd boolean GENERATED ALWAYS AS (collection='visits' AND NOT COALESCE(jsonb_typeof(payload->'day')='string' AND payload->>'day' ~ '^\d{4}-\d\d-\d\d$' AND jsonb_typeof(payload->'at')='string' AND payload->>'at' ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$',false)) STORED;

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

ALTER TABLE gymos.invoice_allocation_refs ENABLE ROW LEVEL SECURITY;

ALTER TABLE gymos.invoice_allocation_refs FORCE ROW LEVEL SECURITY;

ALTER TABLE gymos.invoice_allocation_odd ENABLE ROW LEVEL SECURITY;

ALTER TABLE gymos.invoice_allocation_odd FORCE ROW LEVEL SECURITY;

ALTER TABLE gymos.invoice_allocation_refs_state ENABLE ROW LEVEL SECURITY;

ALTER TABLE gymos.invoice_allocation_refs_state FORCE ROW LEVEL SECURITY;

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

-- HELD DRAFT (review-only, additive, not applied anywhere; remote schema reconciliation required first): branch-scoped member-summary reads.
-- Why: the request-side readers (quota-issues, member candidates) are for ONE branch, but the summary and dirty tables are keyed by owner only, so their joins and the dirty scan
-- depend on the whole owner's rows. A branch column plus (owner_id,branch...) indexes lets a request touch only its branch's marks and summaries.
-- Semantics preserved: a dirty mark is still written for EVERY affected member, including members that no longer exist (their invoices keep the dues-only v:0 row, see recompute).
-- branch of a mark = the member row's CURRENT branch (a move rewrites it through the update trigger); for a member with no row it is the branch of the row that caused the mark.
-- Summary rows carry the branch of the member they were computed for; dues-only v:0 rows keep NULL (they are never candidates).
-- Transition is lazy and cheap: ADD COLUMN (nullable, no default) is catalog-only, there is NO table-wide UPDATE. A summary row with NULL branch is "not found" by the branch-scoped
-- readers and is recomputed (which writes its branch); a live member's mark with NULL or a different branch is still found by the member-key probe and drained by its branch's wave.
-- NULL-branch marks of members that no longer exist stay visible only to the owner-wide refresher. Lock/statement timeouts make the DDL fail fast instead of queueing behind writers.
SET LOCAL lock_timeout='2s';

SET LOCAL statement_timeout='15s';

ALTER TABLE gymos.gym_member_summaries ADD COLUMN IF NOT EXISTS branch text;

ALTER TABLE gymos.gym_member_summary_dirty ADD COLUMN IF NOT EXISTS branch text;

-- One writer for the three triggers: (owner, member, branch of the triggering row) triples.
CREATE OR REPLACE FUNCTION gymos.msum_mark(owners text[],members text[],branches text[]) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
 INSERT INTO gymos.gym_member_summary_dirty(owner_id,member_id,gen,branch)
  SELECT g.o,g.m,nextval('gymos.member_summary_gen'),COALESCE(max(e.branch),max(g.b))
  FROM unnest(owners,members,branches) AS g(o,m,b) LEFT JOIN gymos.gym_entities e ON e.owner_id=g.o AND e.collection='members' AND e.entity_id=g.m
  WHERE g.m IS NOT NULL AND NOT gymos.msum_oversize(g.m) GROUP BY g.o,g.m
  ON CONFLICT(owner_id,member_id) DO UPDATE SET gen=EXCLUDED.gen,branch=EXCLUDED.branch
$$;

REVOKE ALL ON FUNCTION gymos.msum_mark(text[],text[],text[]) FROM PUBLIC;

CREATE OR REPLACE FUNCTION gymos.mark_member_summary_dirty_ins() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
BEGIN
 DELETE FROM gymos.gym_member_summary_ready WHERE owner_id IN (SELECT owner_id FROM newrows WHERE collection IN ('members','visits','payments','invoices') AND gymos.msum_oversize(CASE WHEN collection='members' THEN entity_id ELSE payload->>'member' END));
 PERFORM gymos.msum_mark(array_agg(owner_id),array_agg(CASE WHEN collection='members' THEN entity_id ELSE payload->>'member' END),array_agg(branch)) FROM newrows WHERE collection IN ('members','visits','payments','invoices');
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION gymos.mark_member_summary_dirty_del() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
BEGIN
 DELETE FROM gymos.gym_member_summary_ready WHERE owner_id IN (SELECT owner_id FROM oldrows WHERE collection IN ('members','visits','payments','invoices') AND gymos.msum_oversize(CASE WHEN collection='members' THEN entity_id ELSE payload->>'member' END));
 PERFORM gymos.msum_mark(array_agg(owner_id),array_agg(CASE WHEN collection='members' THEN entity_id ELSE payload->>'member' END),array_agg(branch)) FROM oldrows WHERE collection IN ('members','visits','payments','invoices');
 RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION gymos.mark_member_summary_dirty_upd() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
BEGIN
 DELETE FROM gymos.gym_member_summary_ready WHERE owner_id IN (SELECT owner_id FROM newrows WHERE collection IN ('members','visits','payments','invoices') AND gymos.msum_oversize(CASE WHEN collection='members' THEN entity_id ELSE payload->>'member' END));
 PERFORM gymos.msum_mark(array_agg(owner_id),array_agg(mid),array_agg(branch)) FROM (
   SELECT owner_id,CASE WHEN collection='members' THEN entity_id ELSE payload->>'member' END AS mid,branch FROM newrows WHERE collection IN ('members','visits','payments','invoices')
   UNION ALL
   SELECT owner_id,CASE WHEN collection='members' THEN entity_id ELSE payload->>'member' END,branch FROM oldrows WHERE collection IN ('members','visits','payments','invoices')) x;
 RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION gymos.mark_member_summary_dirty_ins() FROM PUBLIC;

REVOKE ALL ON FUNCTION gymos.mark_member_summary_dirty_del() FROM PUBLIC;

REVOKE ALL ON FUNCTION gymos.mark_member_summary_dirty_upd() FROM PUBLIC;

CREATE OR REPLACE FUNCTION gymos.backfill_member_summaries(target text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
BEGIN
 PERFORM 1 FROM gymos.gym_states WHERE user_id=target FOR UPDATE;
 DELETE FROM gymos.gym_member_summaries WHERE owner_id=target;DELETE FROM gymos.gym_member_summary_dirty WHERE owner_id=target;
 INSERT INTO gymos.gym_member_summary_dirty(owner_id,member_id,gen,branch) SELECT owner_id,entity_id,nextval('gymos.member_summary_gen'),branch FROM gymos.gym_entities WHERE owner_id=target AND collection='members' AND NOT gymos.msum_oversize(entity_id);
 IF NOT EXISTS(SELECT 1 FROM gymos.gym_entities WHERE owner_id=target AND collection IN ('members','visits','payments','invoices') AND gymos.msum_oversize(CASE WHEN collection='members' THEN entity_id ELSE payload->>'member' END)) THEN INSERT INTO gymos.gym_member_summary_ready(owner_id) VALUES(target) ON CONFLICT DO NOTHING; END IF;
END $$;

REVOKE ALL ON FUNCTION gymos.backfill_member_summaries(text) FROM PUBLIC;
COMMIT;
