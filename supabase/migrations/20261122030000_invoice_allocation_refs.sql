-- HELD DRAFT, not applied anywhere. Review only. Shared allocation-reference source for Reports payment rows and member-credit reads.
-- Why: the payload GIN probe (20261121250000) and every payload expression (->>, jsonb_array_elements, &&, @>) are not leakproof, so under ENABLE+FORCE RLS (gymos_app) they cannot be Index Cond and the
-- planner scans every invoice of the owner. Here every probe predicate is a plain column compare (texteq / int ordering, leakproof), so it can be an index condition under the owner policy.
-- Semantics kept exactly: an element is stored only when it is a JSON object whose `payment` is a JSON string (legacy matches with ===); ord is its position in payload.allocations; has_minor/minor keep
-- absent vs null vs number apart. Invoice voided/category are NOT copied (the reader takes them from the invoice row, so they cannot go stale). Invoice position and branch are copied so ordering and branch scope need no payload read.
-- Skipped elements: an element that is not a JSON object, or whose `payment` is not a JSON string, can never equal a string payment id under legacy ===, so omitting it cannot change any read that matches a string id
-- (the Reports reader refuses non-string page payment ids before it reads refs). A consumer that needs those elements (e.g. an allocation-sum over ALL elements) must not use this relation for them.
-- Index key: payment_key = md5(payment_id) (fixed 32 chars), so an oversized payment id can never exceed the btree row limit; payment_id itself stays in the heap and the reader repeats the exact equality, so a hash collision cannot change a result.
-- Writer: AFTER row triggers on gym_entities in the same transaction as the invoice write, running as the invoking role (no SECURITY DEFINER), so the same owner policy applies to the ref writes. NO exception is swallowed:
-- if a ref write fails the whole invoice write rolls back (a failed ref write is a database failure, and a stale ref set must never exist). AFTER TRUNCATE clears the refs too; owner deletion is row DELETE and is covered.
-- Backfill locks each invoice row (FOR UPDATE) before rebuilding it so a concurrent writer cannot be overwritten by an older payload.
-- Readiness: readers use the refs only while invoice_allocation_refs_state has key 'complete' (set by the migration when no invoice exists yet, else only by the held backfill after a zero-mismatch check).
-- Direct writes: gymos_app holds INSERT/UPDATE/DELETE on the refs (the invoking-role trigger needs them), limited to its own owner by RLS; invoice_allocation_refs_mismatches detects any drift. OPEN REVIEW QUESTION, not hidden.
-- Rollback: DROP the triggers, tables and functions; the payload remains the source of truth.
CREATE TABLE IF NOT EXISTS gymos.invoice_allocation_refs(
  owner_id text NOT NULL, invoice_id text NOT NULL, ord integer NOT NULL, payment_id text NOT NULL, payment_key text NOT NULL,
  has_minor boolean NOT NULL, minor jsonb, invoice_position integer NOT NULL, invoice_branch text,
  PRIMARY KEY(owner_id,invoice_id,ord));
CREATE INDEX IF NOT EXISTS invoice_allocation_refs_payment ON gymos.invoice_allocation_refs(owner_id,payment_key,invoice_position,invoice_id,ord);
-- Invoices whose allocations have a shape the refs cannot represent (payload.allocations present but not an array, or any element that is not an object with a string payment). A consumer that must refuse unsupported shapes
-- (member-credit) checks this table (an owner-prefix probe); the Reports reader needs no refusal because such elements cannot match a string payment id.
CREATE TABLE IF NOT EXISTS gymos.invoice_allocation_odd(owner_id text NOT NULL, invoice_id text NOT NULL, odd_elements integer NOT NULL, PRIMARY KEY(owner_id,invoice_id));
CREATE TABLE IF NOT EXISTS gymos.invoice_allocation_refs_state(key text PRIMARY KEY, set_at timestamptz NOT NULL DEFAULT now());

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
CREATE OR REPLACE FUNCTION gymos.invoice_allocation_refs_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') AND OLD.collection='invoices' THEN DELETE FROM gymos.invoice_allocation_refs WHERE owner_id=OLD.owner_id AND invoice_id=OLD.entity_id;DELETE FROM gymos.invoice_allocation_odd WHERE owner_id=OLD.owner_id AND invoice_id=OLD.entity_id; END IF;
  IF TG_OP IN ('INSERT','UPDATE') AND NEW.collection='invoices' THEN
    INSERT INTO gymos.invoice_allocation_refs SELECT * FROM gymos.invoice_allocation_ref_rows(NEW.owner_id,NEW.entity_id,NEW.position,NEW.branch,NEW.payload);
    INSERT INTO gymos.invoice_allocation_odd SELECT NEW.owner_id,NEW.entity_id,gymos.invoice_allocation_odd_count(NEW.payload) WHERE gymos.invoice_allocation_odd_count(NEW.payload)>0;
  END IF;
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION gymos.invoice_allocation_refs_truncate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN TRUNCATE gymos.invoice_allocation_refs,gymos.invoice_allocation_odd; RETURN NULL; END $$;
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
  FOR r IN SELECT entity_id,position,branch,payload FROM gymos.gym_entities WHERE owner_id=p_owner AND collection='invoices' AND (p_after IS NULL OR entity_id>p_after) ORDER BY entity_id LIMIT p_limit FOR UPDATE LOOP
    DELETE FROM gymos.invoice_allocation_refs WHERE owner_id=p_owner AND invoice_id=r.entity_id;DELETE FROM gymos.invoice_allocation_odd WHERE owner_id=p_owner AND invoice_id=r.entity_id;
    INSERT INTO gymos.invoice_allocation_refs SELECT * FROM gymos.invoice_allocation_ref_rows(p_owner,r.entity_id,r.position,r.branch,r.payload);
    INSERT INTO gymos.invoice_allocation_odd SELECT p_owner,r.entity_id,gymos.invoice_allocation_odd_count(r.payload) WHERE gymos.invoice_allocation_odd_count(r.payload)>0;
    last_id:=r.entity_id;n:=n+1;
  END LOOP;
  RETURN CASE WHEN n<p_limit THEN NULL ELSE last_id END; -- NULL = finished
END $$;
-- number of invoices of the owner whose stored refs differ from a recomputation, plus refs of invoices that no longer exist; must be 0 before 'complete' is set
CREATE OR REPLACE FUNCTION gymos.invoice_allocation_refs_mismatches(p_owner text) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT (SELECT count(*) FROM gymos.gym_entities i WHERE i.owner_id=p_owner AND i.collection='invoices' AND
    (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.ord),'[]'::jsonb) FROM gymos.invoice_allocation_refs x WHERE x.owner_id=p_owner AND x.invoice_id=i.entity_id)
    IS DISTINCT FROM
    (SELECT COALESCE(jsonb_agg(to_jsonb(y) ORDER BY y.ord),'[]'::jsonb) FROM gymos.invoice_allocation_ref_rows(p_owner,i.entity_id,i.position,i.branch,i.payload) y))
  + (SELECT count(*) FROM gymos.gym_entities i WHERE i.owner_id=p_owner AND i.collection='invoices' AND COALESCE((SELECT o.odd_elements FROM gymos.invoice_allocation_odd o WHERE o.owner_id=p_owner AND o.invoice_id=i.entity_id),0)<>gymos.invoice_allocation_odd_count(i.payload))
  + (SELECT count(DISTINCT x.invoice_id) FROM gymos.invoice_allocation_refs x WHERE x.owner_id=p_owner AND NOT EXISTS (SELECT 1 FROM gymos.gym_entities i WHERE i.owner_id=p_owner AND i.collection='invoices' AND i.entity_id=x.invoice_id)) $$;

DO $m$ BEGIN IF NOT EXISTS (SELECT 1 FROM gymos.gym_entities WHERE collection='invoices') THEN INSERT INTO gymos.invoice_allocation_refs_state(key) VALUES('complete') ON CONFLICT DO NOTHING; END IF; END $m$;

ALTER TABLE gymos.invoice_allocation_refs ENABLE ROW LEVEL SECURITY;ALTER TABLE gymos.invoice_allocation_refs FORCE ROW LEVEL SECURITY;
ALTER TABLE gymos.invoice_allocation_odd ENABLE ROW LEVEL SECURITY;ALTER TABLE gymos.invoice_allocation_odd FORCE ROW LEVEL SECURITY;
ALTER TABLE gymos.invoice_allocation_refs_state ENABLE ROW LEVEL SECURITY;ALTER TABLE gymos.invoice_allocation_refs_state FORCE ROW LEVEL SECURITY;
DO $p$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='gymos' AND tablename='invoice_allocation_refs' AND policyname='invoice_allocation_refs_runtime') THEN CREATE POLICY invoice_allocation_refs_runtime ON gymos.invoice_allocation_refs TO gymos_app USING(owner_id=current_setting('app.gym_owner',true)) WITH CHECK(owner_id=current_setting('app.gym_owner',true)); END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='gymos' AND tablename='invoice_allocation_odd' AND policyname='invoice_allocation_odd_runtime') THEN CREATE POLICY invoice_allocation_odd_runtime ON gymos.invoice_allocation_odd TO gymos_app USING(owner_id=current_setting('app.gym_owner',true)) WITH CHECK(owner_id=current_setting('app.gym_owner',true)); END IF;
 -- the state row is global (not per owner): readable by the runtime role, writable only by the migration role
 IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='gymos' AND tablename='invoice_allocation_refs_state' AND policyname='invoice_allocation_refs_state_read') THEN CREATE POLICY invoice_allocation_refs_state_read ON gymos.invoice_allocation_refs_state FOR SELECT TO gymos_app USING(true); END IF;
END $p$;
REVOKE ALL ON gymos.invoice_allocation_refs,gymos.invoice_allocation_odd,gymos.invoice_allocation_refs_state FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON gymos.invoice_allocation_refs,gymos.invoice_allocation_odd TO gymos_app;
GRANT SELECT ON gymos.invoice_allocation_refs_state TO gymos_app;

-- Ordinary payment day key (plain columns, so a day range is an Index Cond under RLS instead of a payload-expression Filter). pay_day holds the day only when it is the canonical string; pay_day_odd marks every other payments row
-- (non-string or non-canonical day) so readers can still refuse them exactly. Held: adding stored generated columns rewrites gym_entities (do it in the cutover window or on the fresh rebuild).
ALTER TABLE gymos.gym_entities ADD COLUMN IF NOT EXISTS pay_day text COLLATE "C" GENERATED ALWAYS AS (CASE WHEN collection='payments' AND jsonb_typeof(payload->'day')='string' AND payload->>'day' ~ '^\d{4}-\d\d-\d\d$' THEN payload->>'day' END) STORED;
ALTER TABLE gymos.gym_entities ADD COLUMN IF NOT EXISTS pay_day_odd boolean GENERATED ALWAYS AS (collection='payments' AND NOT COALESCE(jsonb_typeof(payload->'day')='string' AND payload->>'day' ~ '^\d{4}-\d\d-\d\d$',false)) STORED;
CREATE INDEX IF NOT EXISTS gym_entities_pay_day ON gymos.gym_entities(owner_id,branch,pay_day,position,entity_id) WHERE collection='payments' AND pay_day IS NOT NULL;
CREATE INDEX IF NOT EXISTS gym_entities_pay_day_odd ON gymos.gym_entities(owner_id,branch) WHERE pay_day_odd;
