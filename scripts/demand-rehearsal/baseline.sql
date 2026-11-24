CREATE SCHEMA gymos AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA gymos FROM PUBLIC;
GRANT USAGE ON SCHEMA gymos TO gymos_app;
CREATE TABLE gymos."gym_states"("user_id" text NOT NULL,"payload" text NOT NULL,"revision" integer NOT NULL DEFAULT 0,"updated_at" text NOT NULL,CONSTRAINT "gym_states_pkey" PRIMARY KEY (user_id));
ALTER TABLE gymos."gym_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos."gym_states" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON gymos."gym_states" FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON gymos."gym_states" TO gymos_app;
CREATE TABLE gymos."gym_entities"("owner_id" text NOT NULL,"collection" text NOT NULL,"entity_id" text NOT NULL,"position" integer NOT NULL DEFAULT 0,"branch" text,"payload" jsonb NOT NULL,CONSTRAINT "gym_entities_pkey" PRIMARY KEY (owner_id, collection, entity_id));
ALTER TABLE gymos."gym_entities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos."gym_entities" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON gymos."gym_entities" FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON gymos."gym_entities" TO gymos_app;
CREATE TABLE gymos."gym_photos"("owner_id" text NOT NULL,"member_id" text NOT NULL,"content" text NOT NULL,CONSTRAINT "gym_photos_content_check" CHECK ((length(content) <= 96000)),CONSTRAINT "gym_photos_pkey" PRIMARY KEY (owner_id, member_id));
ALTER TABLE gymos."gym_photos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos."gym_photos" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON gymos."gym_photos" FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE,DELETE ON gymos."gym_photos" TO gymos_app;
CREATE TABLE gymos."membership_cards"("code" text NOT NULL,"owner_id" text NOT NULL,"member_id" text NOT NULL,"branch" text NOT NULL,"status" text NOT NULL,"payload" jsonb NOT NULL DEFAULT '{}'::jsonb,"created_at" timestamp with time zone NOT NULL DEFAULT now(),CONSTRAINT "membership_cards_code_check" CHECK ((code ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'::text)),CONSTRAINT "membership_cards_pkey" PRIMARY KEY (owner_id, code),CONSTRAINT "membership_cards_status_check" CHECK ((status = ANY (ARRAY['reserved'::text, 'active'::text, 'lost'::text, 'replaced'::text, 'cancelled'::text]))));
ALTER TABLE gymos."membership_cards" ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos."membership_cards" FORCE ROW LEVEL SECURITY;
REVOKE ALL ON gymos."membership_cards" FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON gymos."membership_cards" TO gymos_app;
CREATE INDEX gym_entities_owner_branch ON gymos.gym_entities USING btree (owner_id, branch, collection);
CREATE INDEX gym_entities_owner_collection_branch_position ON gymos.gym_entities USING btree (owner_id, collection, branch, "position");
CREATE INDEX gym_entities_owner_collection_position ON gymos.gym_entities USING btree (owner_id, collection, "position");
CREATE INDEX gym_members_name ON gymos.gym_entities USING btree (owner_id, lower((payload ->> 'name'::text))) WHERE (collection = 'members'::text);
CREATE INDEX gym_members_phone ON gymos.gym_entities USING btree (owner_id, ((payload ->> 'phone'::text))) WHERE (collection = 'members'::text);
CREATE UNIQUE INDEX gym_visit_one_open ON gymos.gym_entities USING btree (owner_id, ((payload ->> 'member'::text))) WHERE ((collection = 'visits'::text) AND ((payload ->> 'leftAt'::text) IS NULL));
CREATE INDEX membership_cards_member ON gymos.membership_cards USING btree (owner_id, member_id);
CREATE UNIQUE INDEX membership_cards_one_active ON gymos.membership_cards USING btree (owner_id, member_id) WHERE (status = 'active'::text);
CREATE POLICY "gym_entities_runtime" ON gymos."gym_entities" FOR ALL TO gymos_app USING((owner_id = current_setting('app.gym_owner'::text, true))) WITH CHECK((owner_id = current_setting('app.gym_owner'::text, true)));
CREATE POLICY "gym_photos_runtime" ON gymos."gym_photos" FOR ALL TO gymos_app USING((owner_id = current_setting('app.gym_owner'::text, true))) WITH CHECK((owner_id = current_setting('app.gym_owner'::text, true)));
CREATE POLICY "partition_runtime" ON gymos."gym_states" FOR ALL TO gymos_app USING((user_id = current_setting('app.gym_owner'::text, true))) WITH CHECK((user_id = current_setting('app.gym_owner'::text, true)));
CREATE POLICY "membership_cards_runtime" ON gymos."membership_cards" FOR ALL TO gymos_app USING((owner_id = current_setting('app.gym_owner'::text, true))) WITH CHECK((owner_id = current_setting('app.gym_owner'::text, true)));
CREATE OR REPLACE FUNCTION gymos.gym_state_payment_amount_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE doc jsonb;
BEGIN
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 BEGIN
  doc:=NEW.payload::jsonb;
 EXCEPTION WHEN invalid_text_representation THEN
  RETURN NEW; -- Legacy non-JSON rows are handled by the application migration path.
 END;
 IF jsonb_typeof(doc->'payments')='array' AND EXISTS(
   SELECT 1 FROM jsonb_array_elements(doc->'payments') payment
   WHERE payment->'minor' IS NULL OR jsonb_typeof(payment->'minor')<>'number'
      OR (payment->>'minor')::numeric<=0
      OR (payment->>'minor')::numeric>10000000000
      OR (payment->>'minor')::numeric<>trunc((payment->>'minor')::numeric)
 ) THEN
  RAISE EXCEPTION 'invalidPaymentAmount' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $function$
;
REVOKE ALL ON FUNCTION gymos."gym_state_payment_amount_guard"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gymos."gym_state_payment_amount_guard"() TO gymos_app;
CREATE OR REPLACE FUNCTION gymos.sync_membership_cards()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'gymos'
AS $function$
DECLARE c jsonb; holder gymos.membership_cards%ROWTYPE; records jsonb; active_code text;
BEGIN
 IF NEW.collection<>'members' THEN RETURN NEW; END IF;
 active_code:=nullif(NEW.payload->>'card','');records:=coalesce(NEW.payload->'cards','[]'::jsonb);
 IF active_code IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(records) x WHERE x->>'code'=active_code) THEN records:=records||jsonb_build_array(jsonb_build_object('code',active_code,'status','active','issuedAt',null,'history','[]'::jsonb)); END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(records) x WHERE x->>'status'='active')>1 OR EXISTS(SELECT 1 FROM jsonb_array_elements(records) x WHERE (x->>'status'='active') IS DISTINCT FROM coalesce(x->>'code'=active_code,false)) THEN RAISE EXCEPTION 'Invalid active card projection' USING ERRCODE='23514'; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(records))<>(SELECT count(DISTINCT x->>'code') FROM jsonb_array_elements(records) x) THEN RAISE EXCEPTION 'Duplicate card history' USING ERRCODE='23514'; END IF;
 UPDATE gymos.membership_cards SET status='replaced' WHERE owner_id=NEW.owner_id AND member_id=NEW.entity_id AND status='active' AND code IS DISTINCT FROM active_code;
 FOR c IN SELECT value FROM jsonb_array_elements(records) LOOP
  SELECT * INTO holder FROM gymos.membership_cards WHERE owner_id=NEW.owner_id AND code=c->>'code' FOR UPDATE;
  IF FOUND AND (holder.owner_id<>NEW.owner_id OR holder.member_id<>NEW.entity_id) THEN RAISE EXCEPTION 'Barcode already used' USING ERRCODE='23505'; END IF;
  INSERT INTO gymos.membership_cards(code,owner_id,member_id,branch,status,payload) VALUES(c->>'code',NEW.owner_id,NEW.entity_id,NEW.branch,c->>'status',c)
   ON CONFLICT(owner_id,code) DO UPDATE SET status=excluded.status,payload=excluded.payload,branch=excluded.branch WHERE membership_cards.owner_id=excluded.owner_id AND membership_cards.member_id=excluded.member_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Barcode ownership conflict' USING ERRCODE='23505'; END IF;
 END LOOP;
 RETURN NEW;
END $function$
;
REVOKE ALL ON FUNCTION gymos."sync_membership_cards"() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gymos."sync_membership_cards"() TO gymos_app;
CREATE TRIGGER sync_membership_cards AFTER INSERT OR UPDATE OF payload ON gymos.gym_entities FOR EACH ROW EXECUTE FUNCTION gymos.sync_membership_cards();
CREATE TRIGGER gym_state_payment_amount_guard BEFORE INSERT OR UPDATE OF payload ON gymos.gym_states FOR EACH ROW EXECUTE FUNCTION gymos.gym_state_payment_amount_guard();
