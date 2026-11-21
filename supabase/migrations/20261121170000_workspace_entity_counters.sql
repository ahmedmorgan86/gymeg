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
  INSERT INTO gymos.gym_entity_counters(owner_id,collection) VALUES(NEW.user_id,'_ready') ON CONFLICT DO NOTHING;
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
