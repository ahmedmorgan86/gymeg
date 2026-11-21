-- DRAFT, not applied anywhere. Review before any target schema work.
-- Member-scoped reads (portal, hot operations) filter gym_entities by payload->>'member'.
-- Without this index Postgres reads every row of the owner's collection and filters afterwards
-- (measured on synthetic data: 327 buffers for 20,000 owner visits vs 43 with the index, growing with club size).
-- For a large live table create it with CREATE INDEX CONCURRENTLY outside a transaction instead.
CREATE INDEX IF NOT EXISTS gym_entities_owner_member_rows
  ON gymos.gym_entities(owner_id,collection,(payload->>'member'),position)
  WHERE collection IN ('visits','payments','invoices','trainingAssignments','coaching');

-- Guard for hot-operation slices: finds, in O(1), a club that already has a member with more than 1000 freezes.
CREATE INDEX IF NOT EXISTS gym_entities_oversized_freezes
  ON gymos.gym_entities(owner_id)
  WHERE collection='members' AND jsonb_typeof(payload->'freezes')='array' AND jsonb_array_length(payload->'freezes')>1000;

-- Member visit history in the profile's display order (at descending in plain code-point order, ties by position). HELD with the rest of this file.
CREATE INDEX IF NOT EXISTS gym_entities_visit_member_at ON gymos.gym_entities (owner_id,(payload->>'member'),((payload->>'at') COLLATE "C") DESC,position) WHERE collection='visits';
