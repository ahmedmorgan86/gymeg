-- HELD DRAFT, not applied anywhere. Serves "today's visits" for a branch (count and latest rows) without scanning the club's visits.
-- On a large live table create it with CREATE INDEX CONCURRENTLY outside a transaction instead.
CREATE INDEX IF NOT EXISTS gym_entities_visit_branch_day ON gymos.gym_entities (owner_id,branch,(payload->>'day'),position) WHERE collection='visits';
