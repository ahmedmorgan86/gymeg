-- HELD DRAFT, not applied anywhere. Serves the dashboard month total / money trend of a branch (reads only the requested days) without scanning the branch's payments.
-- Exact only while every payment `day` of the branch is canonical: the irregular partial index is empty in normal clubs, so the guard is an index probe, and a non-empty answer
-- sends the dashboard to its packet expression. On a large live table create both with CREATE INDEX CONCURRENTLY outside a transaction instead.
CREATE INDEX IF NOT EXISTS gym_entities_payment_branch_day ON gymos.gym_entities (owner_id,branch,((payload->>'day') COLLATE "C"),position) WHERE collection='payments' AND payload->>'day' ~ '^\d{4}-\d\d-\d\d$';
CREATE INDEX IF NOT EXISTS gym_entities_payment_irregular_day ON gymos.gym_entities (owner_id,branch,position) WHERE collection='payments' AND (jsonb_typeof(payload->'day') IS DISTINCT FROM 'string' OR payload->>'day' !~ '^\d{4}-\d\d-\d\d$');
