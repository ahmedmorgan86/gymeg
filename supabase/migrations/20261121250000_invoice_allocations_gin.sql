-- HELD DRAFT, not applied anywhere. Which invoices of an owner allocate a given payment (Reports receipts breakdown) without scanning every invoice of the owner.
-- The key carries the owner (payment ids repeat across owners), so one GIN probe returns only that owner's invoices; the reader still repeats the exact containment test, so a hash collision
-- or a non-string allocation payment can never change a result. Only string allocation payments are keyed (legacy compares with ===). Write cost: one GIN entry per distinct allocated payment.
-- On a large live table create the index with CREATE INDEX CONCURRENTLY outside a transaction instead.
CREATE OR REPLACE FUNCTION gymos.invoice_alloc_keys(owner text,payload jsonb) RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(array_agg(DISTINCT md5(owner||'|'||(a->>'payment'))) FILTER (WHERE jsonb_typeof(a->'payment')='string'),ARRAY[]::text[])
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(payload->'allocations')='array' THEN payload->'allocations' ELSE '[]'::jsonb END) a $$;
CREATE INDEX IF NOT EXISTS gym_entities_invoice_allocations ON gymos.gym_entities USING gin (gymos.invoice_alloc_keys(owner_id,payload)) WHERE collection='invoices';
