-- HELD DRAFT, not applied anywhere. Open visits of a branch (check-in profile popup) and the guard probe for falsy non-null leftAt values. Both partial indexes are small:
-- the first holds only currently open visits (at most one per member, see gym_visit_one_open), the second is empty in normal clubs.
-- On a large live table create them with CREATE INDEX CONCURRENTLY outside a transaction instead.
CREATE INDEX IF NOT EXISTS gym_entities_visit_open_branch ON gymos.gym_entities (owner_id,branch,position,entity_id) WHERE collection='visits' AND payload->>'leftAt' IS NULL;
CREATE INDEX IF NOT EXISTS gym_entities_visit_falsy_leftat ON gymos.gym_entities (owner_id,branch,position) WHERE collection='visits' AND payload->>'leftAt' IN ('','false','0');
