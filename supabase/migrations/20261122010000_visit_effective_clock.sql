-- HELD DRAFT. Exact canonical UTC visit-clock detection, conservative for old
-- malformed timestamps. Invalid dates return false rather than block a write.
CREATE OR REPLACE FUNCTION gymos.canonical_visit_clock(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL UNSAFE AS $$
DECLARE t text;
BEGIN
 IF jsonb_typeof(COALESCE(NULLIF(p->'activeAt','null'::jsonb),p->'at')) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
 t=COALESCE(p->>'activeAt',p->>'at');
 IF t !~ '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$' THEN RETURN false; END IF;
 RETURN to_char(t::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')=t;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
CREATE INDEX IF NOT EXISTS gym_entities_visit_member_clock ON gymos.gym_entities
 (owner_id,md5(payload->>'member'),branch,((COALESCE(payload->>'activeAt',payload->>'at')) COLLATE "C") DESC,position)
 WHERE collection='visits' AND gymos.canonical_visit_clock(payload);
CREATE INDEX IF NOT EXISTS gym_entities_visit_irregular_clock ON gymos.gym_entities(owner_id,branch)
 WHERE collection='visits' AND NOT gymos.canonical_visit_clock(payload);
