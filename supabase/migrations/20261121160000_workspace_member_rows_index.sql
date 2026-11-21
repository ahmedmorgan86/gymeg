-- DRAFT, not applied anywhere. Review before any target schema work.
-- Member-scoped reads (portal, hot operations) filter gym_entities by payload->>'member'.
-- Without this index Postgres reads every row of the owner's collection and filters afterwards
-- (measured on synthetic data: 327 buffers for 20,000 owner visits vs 43 with the index, growing with club size).
-- For a large live table create it with CREATE INDEX CONCURRENTLY outside a transaction instead.
CREATE INDEX IF NOT EXISTS gym_entities_owner_member_rows
  ON gymos.gym_entities(owner_id,collection,(payload->>'member'),position)
  WHERE collection IN ('visits','payments','invoices','trainingAssignments','coaching');
