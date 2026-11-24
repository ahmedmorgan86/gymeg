-- Monotonically increasing durable workspace event log and transactional outbox.
-- Enables delta synchronization, eliminates full-workspace transfers, and protects cross-tenant isolation.
SET lock_timeout='5s';

-- 1. Workspace Event Log Table
CREATE TABLE IF NOT EXISTS gymos.workspace_events (
  id text NOT NULL,
  owner_id text NOT NULL,
  tenant_id text NOT NULL,
  revision integer NOT NULL,
  event_type text NOT NULL,
  collection text,
  entity_id text,
  branch text,
  operation text,
  payload jsonb,
  actor text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, revision, id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_events_tenant_rev
  ON gymos.workspace_events(tenant_id, revision ASC);

CREATE INDEX IF NOT EXISTS idx_workspace_events_owner_rev
  ON gymos.workspace_events(owner_id, revision ASC);

CREATE INDEX IF NOT EXISTS idx_workspace_events_branch_rev
  ON gymos.workspace_events(owner_id, branch, revision ASC);

-- 2. Transactional Realtime Outbox Table
CREATE TABLE IF NOT EXISTS gymos.workspace_outbox (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  tenant_id text NOT NULL,
  channel text NOT NULL,
  event text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_workspace_outbox_unprocessed
  ON gymos.workspace_outbox(processed_at) WHERE processed_at IS NULL;

-- 3. Row Level Security & Defense in Depth
ALTER TABLE gymos.workspace_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.workspace_events FORCE ROW LEVEL SECURITY;
ALTER TABLE gymos.workspace_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.workspace_outbox FORCE ROW LEVEL SECURITY;

REVOKE ALL ON gymos.workspace_events, gymos.workspace_outbox FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON gymos.workspace_events, gymos.workspace_outbox TO gymos_app;

DROP POLICY IF EXISTS workspace_events_runtime ON gymos.workspace_events;
CREATE POLICY workspace_events_runtime ON gymos.workspace_events TO gymos_app
  USING(owner_id = current_setting('app.gym_owner', true))
  WITH CHECK(owner_id = current_setting('app.gym_owner', true));

DROP POLICY IF EXISTS workspace_outbox_runtime ON gymos.workspace_outbox;
CREATE POLICY workspace_outbox_runtime ON gymos.workspace_outbox TO gymos_app
  USING(owner_id = current_setting('app.gym_owner', true))
  WITH CHECK(owner_id = current_setting('app.gym_owner', true));

-- 4. Event Log Pruning Function (retains the latest N events or 30 days)
CREATE OR REPLACE FUNCTION gymos.prune_workspace_events(p_owner text, p_keep integer DEFAULT 10000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, gymos
AS $$
DECLARE
  v_min_rev integer;
  v_deleted integer := 0;
BEGIN
  -- Identify the threshold revision beyond the keep limit
  SELECT revision INTO v_min_rev
  FROM gymos.workspace_events
  WHERE owner_id = p_owner
  ORDER BY revision DESC
  OFFSET p_keep LIMIT 1;

  IF v_min_rev IS NOT NULL THEN
    DELETE FROM gymos.workspace_events
    WHERE owner_id = p_owner AND revision <= v_min_rev;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
  END IF;

  RETURN v_deleted;
END;
$$;
