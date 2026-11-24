-- HELD CANDIDATE. GENERATED SOURCE FOR REVIEW/ISOLATED REHEARSAL ONLY. NOT PRODUCTION APPROVAL.
-- Every statement MUST run independently, outside a transaction.
SET lock_timeout='2s'; SET statement_timeout='60s';
CREATE INDEX CONCURRENTLY IF NOT EXISTS gym_entities_visit_member_clock ON gymos.gym_entities
 (owner_id,md5(payload->>'member'),branch,((COALESCE(payload->>'activeAt',payload->>'at')) COLLATE "C") DESC,position)
 WHERE collection='visits' AND gymos.canonical_visit_clock(payload);

CREATE INDEX CONCURRENTLY IF NOT EXISTS gym_entities_visit_irregular_clock ON gymos.gym_entities(owner_id,branch)
 WHERE collection='visits' AND NOT gymos.canonical_visit_clock(payload);

CREATE INDEX CONCURRENTLY gym_entities_demand_member_rows ON gymos.gym_entities
 (owner_id,collection,demand_member_hash,branch,position)
 WHERE demand_member_hash IS NOT NULL;

CREATE INDEX CONCURRENTLY gym_entities_demand_visit_day ON gymos.gym_entities
 (owner_id,branch,demand_member_hash,demand_visit_day DESC)
 WHERE collection='visits' AND demand_visit_day IS NOT NULL;

CREATE INDEX CONCURRENTLY gym_entities_demand_visit_clock ON gymos.gym_entities
 (owner_id,branch,demand_member_hash,demand_visit_clock DESC,position)
 WHERE collection='visits' AND demand_visit_clock IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS invoice_allocation_refs_payment ON gymos.invoice_allocation_refs(owner_id,payment_key,invoice_position,invoice_id,ord);

CREATE INDEX CONCURRENTLY IF NOT EXISTS gym_entities_pay_day ON gymos.gym_entities(owner_id,branch,pay_day,position,entity_id) WHERE collection='payments' AND pay_day IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS gym_entities_pay_day_odd ON gymos.gym_entities(owner_id,branch) WHERE pay_day_odd;

CREATE INDEX CONCURRENTLY IF NOT EXISTS gym_entities_visit_odd ON gymos.gym_entities(owner_id,branch,position,entity_id) WHERE visit_odd;

CREATE INDEX CONCURRENTLY IF NOT EXISTS gym_entities_visit_member_odd ON gymos.gym_entities(owner_id,branch) WHERE collection='visits' AND demand_member_hash IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS gym_entities_visit_day_count ON gymos.gym_entities(owner_id,branch,demand_visit_day) WHERE collection='visits' AND demand_visit_day IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS gym_entities_visit_canon_order ON gymos.gym_entities(owner_id,branch,demand_visit_day DESC,visit_at DESC,position,entity_id) WHERE collection='visits' AND NOT visit_odd;

CREATE INDEX CONCURRENTLY IF NOT EXISTS gym_member_summaries_branch ON gymos.gym_member_summaries(owner_id,branch,member_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS gym_member_summary_dirty_branch ON gymos.gym_member_summary_dirty(owner_id,branch,gen);
