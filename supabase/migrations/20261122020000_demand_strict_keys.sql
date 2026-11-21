-- HELD DRAFT. Ordinary generated keys allow runtime FORCE-RLS plans to use
-- member/range index conditions. Expression keys alone are not sufficient:
-- JSON extraction is not leakproof, so it stays above the RLS security barrier.
-- No role, policy, function-security or LEAKPROOF changes.
-- ALTER TABLE rewrites/backfills existing rows under a lock. Production rollout
-- needs separately reviewed maintenance/concurrent-index planning. Not applied.
-- The exception-catching calendar validator opens a subtransaction. It must
-- never run in a parallel worker, including a generated-column backfill.
ALTER FUNCTION gymos.canonical_visit_clock(jsonb) PARALLEL UNSAFE;
ALTER TABLE gymos.gym_entities
 ADD COLUMN demand_member_hash text GENERATED ALWAYS AS
  (CASE WHEN jsonb_typeof(payload->'member')='string' THEN md5(payload->>'member') END) STORED,
 ADD COLUMN demand_visit_day text COLLATE "C" GENERATED ALWAYS AS
  (CASE WHEN collection='visits' AND jsonb_typeof(payload->'day')='string'
    AND payload->>'day' ~ '^\d{4}-\d\d-\d\d$' THEN payload->>'day' END) STORED,
 ADD COLUMN demand_visit_clock text COLLATE "C" GENERATED ALWAYS AS
  (CASE WHEN collection='visits' AND gymos.canonical_visit_clock(payload)
    THEN COALESCE(payload->>'activeAt',payload->>'at') END) STORED;
-- Hash is fixed-size and clocks are bounded canonical strings. Old malformed
-- values and arbitrary-length member keys cannot create oversized index keys.
CREATE INDEX gym_entities_demand_member_rows ON gymos.gym_entities
 (owner_id,collection,demand_member_hash,branch,position)
 WHERE demand_member_hash IS NOT NULL;
CREATE INDEX gym_entities_demand_visit_day ON gymos.gym_entities
 (owner_id,branch,demand_member_hash,demand_visit_day DESC)
 WHERE collection='visits' AND demand_visit_day IS NOT NULL;
CREATE INDEX gym_entities_demand_visit_clock ON gymos.gym_entities
 (owner_id,branch,demand_member_hash,demand_visit_clock DESC,position)
 WHERE collection='visits' AND demand_visit_clock IS NOT NULL;
-- Rollback (only after turning candidate readers OFF): DROP the three indexes,
-- then DROP COLUMN demand_visit_clock, demand_visit_day, demand_member_hash.
-- This removes derived data only. Never drop canonical_visit_clock while an
-- earlier clock index still depends on it. Original entity payloads are intact.
