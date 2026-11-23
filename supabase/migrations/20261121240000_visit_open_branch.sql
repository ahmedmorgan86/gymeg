-- HELD DRAFT, not applied anywhere. Open visits of a branch (check-in profile popup) and the guard probe for a leftAt that is not a non-empty string (number incl. 0.0, boolean, object, array, empty string). Both partial indexes are small:
-- the first holds only currently open visits (at most one per member, see gym_visit_one_open), the second is empty in normal clubs.
-- On a large live table create them with CREATE INDEX CONCURRENTLY outside a transaction instead.
CREATE INDEX IF NOT EXISTS gym_entities_visit_open_branch ON gymos.gym_entities (owner_id,branch,position,entity_id) WHERE collection='visits' AND payload->>'leftAt' IS NULL;
CREATE INDEX IF NOT EXISTS gym_entities_visit_odd_leftat ON gymos.gym_entities (owner_id,branch,position) WHERE collection='visits' AND (jsonb_typeof(payload->'leftAt') IN ('number','boolean','object','array') OR payload->>'leftAt'='');
