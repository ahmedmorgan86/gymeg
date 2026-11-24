-- HELD DRAFT, not applied anywhere. Latest visit day <= any `today` of one member inside one branch (manual WhatsApp reminders): a reverse index probe per member,
-- so the cost is O(members x log visits), not O(branch visits). Exact only while the branch has no non-canonical day (the irregular partial index probes that).
-- On a large live table create it with CREATE INDEX CONCURRENTLY outside a transaction instead.
CREATE INDEX IF NOT EXISTS gym_entities_visit_member_branch_day ON gymos.gym_entities (owner_id,md5(payload->>'member'),branch,((payload->>'day') COLLATE "C") DESC) WHERE collection='visits' AND payload->>'day' ~ '^\d{4}-\d\d-\d\d$';
-- A visit whose `member` is not a JSON string (->> would coerce a number to text and change the legacy Map keys): the reminders read refuses and the screen keeps its packet path.
-- Empty in normal clubs, so the guard is an index probe.
CREATE INDEX IF NOT EXISTS gym_entities_visit_member_nonstring ON gymos.gym_entities (owner_id,branch,position) WHERE collection='visits' AND jsonb_typeof(payload->'member') IS DISTINCT FROM 'string';
