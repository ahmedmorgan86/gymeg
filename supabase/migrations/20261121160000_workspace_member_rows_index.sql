-- DRAFT, not applied anywhere. Review before any target schema work.
-- Member keys are indexed as md5(payload->>'member') (fixed 32 bytes): an arbitrary-length member value, accepted by the legacy state rules, can never exceed the btree key size and block a write.
-- Every reader repeats the exact equality next to the md5 equality, so a hash collision can never return another member's row.
-- Member-scoped reads (portal, hot operations) filter gym_entities by payload->>'member'.
-- Without this index Postgres reads every row of the owner's collection and filters afterwards
-- (measured on synthetic data: 327 buffers for 20,000 owner visits vs 43 with the index, growing with club size).
-- For a large live table create it with CREATE INDEX CONCURRENTLY outside a transaction instead.
CREATE INDEX IF NOT EXISTS gym_entities_owner_member_rows
  ON gymos.gym_entities(owner_id,collection,md5(payload->>'member'),position)
  WHERE collection IN ('visits','payments','invoices','trainingAssignments','coaching');

-- Guard for hot-operation slices: finds, in O(1), a club that already has a member with more than 1000 freezes.
CREATE INDEX IF NOT EXISTS gym_entities_oversized_freezes
  ON gymos.gym_entities(owner_id)
  WHERE collection='members' AND jsonb_typeof(payload->'freezes')='array' AND jsonb_array_length(payload->'freezes')>1000;

-- Member visit history in the profile's display order (at descending in plain code-point order, ties by position). HELD with the rest of this file.
CREATE INDEX IF NOT EXISTS gym_entities_visit_member_at ON gymos.gym_entities (owner_id,md5(payload->>'member'),((payload->>'at') COLLATE "C") DESC,position) WHERE collection='visits' AND payload->>'at' ~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$';
-- Only canonical `at` values are indexed: an arbitrary-length string would exceed the btree row limit and block the insert (SQLSTATE 54000); those rows are served by the exact irregular path.
-- Visits whose `at` is missing, not a string, or not the canonical ISO form. Empty in normal clubs, so the history route's order check is an index probe. HELD.
CREATE INDEX IF NOT EXISTS gym_entities_visit_irregular_at ON gymos.gym_entities (owner_id,md5(payload->>'member')) WHERE collection='visits' AND (jsonb_typeof(payload->'at') IS DISTINCT FROM 'string' OR payload->>'at' !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$');
