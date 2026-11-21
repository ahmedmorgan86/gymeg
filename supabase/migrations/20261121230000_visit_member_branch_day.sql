-- HELD DRAFT, not applied anywhere. Latest visit day <= any `today` of one member inside one branch (manual WhatsApp reminders): a reverse index probe per member,
-- so the cost is O(members x log visits), not O(branch visits). Exact only while the branch has no non-canonical day (the irregular partial index probes that).
-- On a large live table create it with CREATE INDEX CONCURRENTLY outside a transaction instead.
CREATE INDEX IF NOT EXISTS gym_entities_visit_member_branch_day ON gymos.gym_entities (owner_id,md5(payload->>'member'),branch,((payload->>'day') COLLATE "C") DESC) WHERE collection='visits' AND payload->>'day' ~ '^\d{4}-\d\d-\d\d$';
