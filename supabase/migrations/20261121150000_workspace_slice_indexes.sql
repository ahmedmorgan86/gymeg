-- Paged, branch-scoped collection reads order by position inside one collection.
CREATE INDEX IF NOT EXISTS gym_entities_owner_collection_position ON gymos.gym_entities(owner_id,collection,position);
CREATE INDEX IF NOT EXISTS gym_entities_owner_collection_branch_position ON gymos.gym_entities(owner_id,collection,branch,position);
