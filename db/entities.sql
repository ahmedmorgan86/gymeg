CREATE TABLE IF NOT EXISTS gymos.gym_entities (
 owner_id text NOT NULL, collection text NOT NULL, entity_id text NOT NULL,
 position integer NOT NULL DEFAULT 0, branch text, payload jsonb NOT NULL,
 PRIMARY KEY(owner_id,collection,entity_id)
);
CREATE INDEX IF NOT EXISTS gym_entities_owner_branch ON gymos.gym_entities(owner_id,branch,collection);
CREATE TABLE IF NOT EXISTS gymos.gym_photos (
 owner_id text NOT NULL, member_id text NOT NULL, content text NOT NULL,
 PRIMARY KEY(owner_id,member_id), CHECK(length(content)<=22000)
);
ALTER TABLE gymos.gym_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.gym_entities FORCE ROW LEVEL SECURITY;
ALTER TABLE gymos.gym_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.gym_photos FORCE ROW LEVEL SECURITY;
DO $policy$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='gymos' AND tablename='gym_entities' AND policyname='gym_entities_runtime') THEN CREATE POLICY gym_entities_runtime ON gymos.gym_entities TO gymos_app USING(owner_id=current_setting('app.gym_owner',true)) WITH CHECK(owner_id=current_setting('app.gym_owner',true)); END IF; END $policy$;
DO $policy$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='gymos' AND tablename='gym_photos' AND policyname='gym_photos_runtime') THEN CREATE POLICY gym_photos_runtime ON gymos.gym_photos TO gymos_app USING(owner_id=current_setting('app.gym_owner',true)) WITH CHECK(owner_id=current_setting('app.gym_owner',true)); END IF; END $policy$;
REVOKE ALL ON gymos.gym_entities,gymos.gym_photos FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON gymos.gym_entities,gymos.gym_photos TO gymos_app;

CREATE TABLE IF NOT EXISTS gymos.workspace_events (
  id text NOT NULL, owner_id text NOT NULL, tenant_id text NOT NULL,
  revision integer NOT NULL, event_type text NOT NULL, collection text,
  entity_id text, branch text, operation text, payload jsonb, actor text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id, revision, id)
);
CREATE INDEX IF NOT EXISTS idx_workspace_events_tenant_rev ON gymos.workspace_events(tenant_id, revision ASC);
CREATE INDEX IF NOT EXISTS idx_workspace_events_owner_rev ON gymos.workspace_events(owner_id, revision ASC);

CREATE TABLE IF NOT EXISTS gymos.workspace_outbox (
  id text PRIMARY KEY, owner_id text NOT NULL, tenant_id text NOT NULL,
  channel text NOT NULL, event text NOT NULL, payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_workspace_outbox_unprocessed ON gymos.workspace_outbox(processed_at) WHERE processed_at IS NULL;

ALTER TABLE gymos.workspace_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.workspace_events FORCE ROW LEVEL SECURITY;
ALTER TABLE gymos.workspace_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.workspace_outbox FORCE ROW LEVEL SECURITY;

DO $policy$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='gymos' AND tablename='workspace_events' AND policyname='workspace_events_runtime') THEN CREATE POLICY workspace_events_runtime ON gymos.workspace_events TO gymos_app USING(owner_id=current_setting('app.gym_owner',true)) WITH CHECK(owner_id=current_setting('app.gym_owner',true)); END IF; END $policy$;
DO $policy$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='gymos' AND tablename='workspace_outbox' AND policyname='workspace_outbox_runtime') THEN CREATE POLICY workspace_outbox_runtime ON gymos.workspace_outbox TO gymos_app USING(owner_id=current_setting('app.gym_owner',true)) WITH CHECK(owner_id=current_setting('app.gym_owner',true)); END IF; END $policy$;
REVOKE ALL ON gymos.workspace_events,gymos.workspace_outbox FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON gymos.workspace_events,gymos.workspace_outbox TO gymos_app;

