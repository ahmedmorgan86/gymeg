-- Private in-app support requests for PostgreSQL/Supabase deployments,
-- matching the Firestore support-request lifecycle with strict gymos_app RLS.
CREATE TABLE IF NOT EXISTS gymos.support_requests (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9]{20}$'),
  requester text NOT NULL CHECK (length(requester) BETWEEN 1 AND 250),
  assignee text CHECK (assignee IS NULL OR length(assignee) BETWEEN 1 AND 250),
  title text NOT NULL CHECK (length(title) BETWEEN 3 AND 120),
  status text NOT NULL CHECK (status IN ('open', 'in_progress', 'resolved')),
  client_request_id text CHECK (client_request_id IS NULL OR client_request_id ~ '^[a-f0-9-]{36}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_requests_requester_updated_idx
  ON gymos.support_requests (requester, updated_at DESC);
CREATE INDEX IF NOT EXISTS support_requests_updated_idx
  ON gymos.support_requests (updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS support_requests_idempotent_create_idx
  ON gymos.support_requests (requester, client_request_id)
  WHERE client_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS gymos.support_request_messages (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9]{20}$'),
  request_id text NOT NULL REFERENCES gymos.support_requests(id) ON DELETE CASCADE,
  author text NOT NULL CHECK (length(author) BETWEEN 1 AND 250),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_request_messages_request_at_idx
  ON gymos.support_request_messages (request_id, at DESC);

CREATE TABLE IF NOT EXISTS gymos.support_request_updates (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9]{20}$'),
  recipient text NOT NULL CHECK (length(recipient) BETWEEN 1 AND 250),
  request_id text NOT NULL REFERENCES gymos.support_requests(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('claim', 'reply', 'resolve')),
  at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_request_updates_recipient_at_idx
  ON gymos.support_request_updates (recipient, at DESC);

DO $rls$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['support_requests', 'support_request_messages', 'support_request_updates'] LOOP
    EXECUTE format('ALTER TABLE gymos.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE gymos.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON gymos.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON gymos.%I TO gymos_app', t);
  END LOOP;
END $rls$;

DROP POLICY IF EXISTS support_requests_select ON gymos.support_requests;
DROP POLICY IF EXISTS support_requests_insert ON gymos.support_requests;
DROP POLICY IF EXISTS support_requests_update ON gymos.support_requests;
CREATE POLICY support_requests_select ON gymos.support_requests
  FOR SELECT TO gymos_app
  USING (requester = current_setting('app.actor', true) OR current_setting('app.platform', true) = '1');
CREATE POLICY support_requests_insert ON gymos.support_requests
  FOR INSERT TO gymos_app
  WITH CHECK (requester = current_setting('app.actor', true) AND assignee IS NULL AND status = 'open');
CREATE POLICY support_requests_update ON gymos.support_requests
  FOR UPDATE TO gymos_app
  USING (
    (requester = current_setting('app.actor', true) AND status <> 'resolved')
    OR (current_setting('app.platform', true) = '1' AND (assignee IS NULL OR assignee = current_setting('app.actor', true)))
  )
  WITH CHECK (
    (current_setting('app.platform', true) = '1' AND (assignee = current_setting('app.actor', true) OR assignee IS NULL))
    OR (requester = current_setting('app.actor', true) AND status <> 'resolved')
  );
REVOKE DELETE ON gymos.support_requests FROM gymos_app;

DROP POLICY IF EXISTS support_request_messages_select ON gymos.support_request_messages;
DROP POLICY IF EXISTS support_request_messages_insert ON gymos.support_request_messages;
CREATE POLICY support_request_messages_select ON gymos.support_request_messages
  FOR SELECT TO gymos_app
  USING (EXISTS (
    SELECT 1 FROM gymos.support_requests r
    WHERE r.id = request_id AND (r.requester = current_setting('app.actor', true) OR current_setting('app.platform', true) = '1')
  ));
CREATE POLICY support_request_messages_insert ON gymos.support_request_messages
  FOR INSERT TO gymos_app
  WITH CHECK (
    author = current_setting('app.actor', true)
    AND EXISTS (
      SELECT 1 FROM gymos.support_requests r
      WHERE r.id = request_id AND r.status <> 'resolved'
        AND (r.requester = current_setting('app.actor', true) OR (current_setting('app.platform', true) = '1' AND r.assignee = current_setting('app.actor', true)))
    )
  );
REVOKE UPDATE, DELETE ON gymos.support_request_messages FROM gymos_app;

DROP POLICY IF EXISTS support_request_updates_select ON gymos.support_request_updates;
DROP POLICY IF EXISTS support_request_updates_insert ON gymos.support_request_updates;
CREATE POLICY support_request_updates_select ON gymos.support_request_updates
  FOR SELECT TO gymos_app
  USING (recipient = current_setting('app.actor', true));
CREATE POLICY support_request_updates_insert ON gymos.support_request_updates
  FOR INSERT TO gymos_app
  WITH CHECK (
    recipient <> current_setting('app.actor', true)
    AND EXISTS (
      SELECT 1 FROM gymos.support_requests r
      WHERE r.id = request_id AND (r.requester = current_setting('app.actor', true) OR current_setting('app.platform', true) = '1')
    )
  );
REVOKE UPDATE, DELETE ON gymos.support_request_updates FROM gymos_app;
