-- HELD DRAFT, not applied anywhere. Serves "today's visits" for a branch (count and latest rows) without scanning the club's visits.
-- On a large live table create it with CREATE INDEX CONCURRENTLY outside a transaction instead.
CREATE INDEX IF NOT EXISTS gym_entities_visit_branch_day ON gymos.gym_entities (owner_id,branch,(payload->>'day'),position) WHERE collection='visits';
-- Attendance page: the branch's newest 100 visits by (day desc, at desc, position asc), plain code-point order. Exact only while every `day` and `at` of the branch is canonical:
-- the irregular partial index below is empty in normal clubs, so the guard is an index probe, and a non-empty answer sends the page to the legacy path.
CREATE INDEX IF NOT EXISTS gym_entities_visit_branch_dayat ON gymos.gym_entities (owner_id,branch,((payload->>'day') COLLATE "C") DESC,((payload->>'at') COLLATE "C") DESC,position) WHERE collection='visits';
CREATE INDEX IF NOT EXISTS gym_entities_visit_irregular_dayat ON gymos.gym_entities (owner_id,branch,position) WHERE collection='visits' AND (jsonb_typeof(payload->'day') IS DISTINCT FROM 'string' OR payload->>'day' !~ '^\d{4}-\d\d-\d\d$' OR jsonb_typeof(payload->'at') IS DISTINCT FROM 'string' OR payload->>'at' !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$');
