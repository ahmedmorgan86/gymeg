-- Security repair (local, NOT covered by FINAL2 acceptance): non-owner branch
-- grants must be a JSON array of strings. JSON null/false/0/object/string used
-- to be stored as-is (null = "all branches" in the runtime context), which
-- let a malformed staff grant widen to every branch. Owner rows keep NULL.
CREATE OR REPLACE FUNCTION gymos.normalize_branch_scope(value jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE
  WHEN value IS NULL OR jsonb_typeof(value)<>'array' THEN '[]'::jsonb
  WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(value) e WHERE jsonb_typeof(e)<>'string') THEN '[]'::jsonb
  ELSE value END
$$;
REVOKE ALL ON FUNCTION gymos.normalize_branch_scope(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION gymos.normalize_branch_scope(jsonb) TO gymos_app;

CREATE OR REPLACE FUNCTION gymos.safe_branches_json(value text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog,gymos AS $$
BEGIN
 IF value IS NULL THEN RETURN '[]'::jsonb; END IF;
 RETURN gymos.normalize_branch_scope(value::jsonb);
EXCEPTION WHEN invalid_text_representation THEN RETURN '[]'::jsonb;
END $$;

CREATE OR REPLACE FUNCTION gymos.membership_branch_scope_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,gymos AS $$
BEGIN
 IF NEW.role<>'owner' THEN NEW.branches:=gymos.normalize_branch_scope(NEW.branches); END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS tenant_memberships_branch_scope ON gymos.tenant_memberships;
CREATE TRIGGER tenant_memberships_branch_scope BEFORE INSERT OR UPDATE OF role,branches ON gymos.tenant_memberships
 FOR EACH ROW EXECUTE FUNCTION gymos.membership_branch_scope_guard();

-- Repair existing malformed non-owner rows (fail closed to an empty scope).
UPDATE gymos.tenant_memberships SET branches=gymos.normalize_branch_scope(branches)
 WHERE role<>'owner' AND branches IS DISTINCT FROM gymos.normalize_branch_scope(branches);
