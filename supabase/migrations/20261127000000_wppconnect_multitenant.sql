-- Multi-tenant WPPConnect integration: provider connections, inbox, messages, auto-replies, audit logs,
-- and non-breaking outbox extensions with strict gymos_app RLS.

CREATE TABLE IF NOT EXISTS gymos.whatsapp_provider_connections (
  owner_id text NOT NULL,
  branch text NOT NULL,
  provider text NOT NULL DEFAULT 'meta' CHECK (provider IN ('meta', 'wppconnect', 'manual')),
  session_id text NOT NULL,
  status text NOT NULL DEFAULT 'DISCONNECTED' CHECK (status IN (
    'DISCONNECTED', 'STARTING', 'WAITING_FOR_QR', 'QR_EXPIRED', 'CONNECTING', 'CONNECTED', 'RECONNECTING', 'FAILED'
  )),
  desired_action text NOT NULL DEFAULT 'none' CHECK (desired_action IN ('none', 'connect', 'disconnect', 'status')),
  connected_phone text,
  qr_data_url text,
  qr_expires_at timestamptz,
  last_connected_at timestamptz,
  last_error text,
  daily_limit integer NOT NULL DEFAULT 250 CHECK (daily_limit BETWEEN 1 AND 5000),
  sent_today integer NOT NULL DEFAULT 0,
  sent_day text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, branch)
);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_provider_session_idx
  ON gymos.whatsapp_provider_connections (session_id);

CREATE TABLE IF NOT EXISTS gymos.whatsapp_inbox (
  owner_id text NOT NULL,
  id text NOT NULL,
  branch text NOT NULL,
  member_id text,
  phone_hash text NOT NULL,
  display_phone text NOT NULL,
  contact_name text NOT NULL DEFAULT '',
  assigned_to text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  unread_count integer NOT NULL DEFAULT 0,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  last_auto_reply_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_inbox_phone_idx
  ON gymos.whatsapp_inbox (owner_id, branch, phone_hash);
CREATE INDEX IF NOT EXISTS whatsapp_inbox_recent_idx
  ON gymos.whatsapp_inbox (owner_id, branch, last_message_at DESC);

CREATE TABLE IF NOT EXISTS gymos.whatsapp_messages (
  owner_id text NOT NULL,
  id text NOT NULL,
  inbox_id text NOT NULL,
  branch text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  provider text NOT NULL CHECK (provider IN ('meta', 'wppconnect', 'manual')),
  provider_message_id text,
  body text NOT NULL DEFAULT '',
  media_type text,
  media_url text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'failed', 'received')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_messages_provider_dedup_idx
  ON gymos.whatsapp_messages (owner_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS whatsapp_messages_inbox_idx
  ON gymos.whatsapp_messages (owner_id, inbox_id, created_at DESC);

CREATE TABLE IF NOT EXISTS gymos.whatsapp_auto_replies (
  owner_id text NOT NULL,
  id text NOT NULL,
  branch text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  name text NOT NULL DEFAULT '',
  keywords text[] NOT NULL DEFAULT '{}',
  reply_text text NOT NULL DEFAULT '',
  welcome_text text NOT NULL DEFAULT '',
  off_hours_text text NOT NULL DEFAULT '',
  active_days integer[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  start_hour integer NOT NULL DEFAULT 8 CHECK (start_hour BETWEEN 0 AND 23),
  end_hour integer NOT NULL DEFAULT 23 CHECK (end_hour BETWEEN 0 AND 23),
  handoff_to_staff boolean NOT NULL DEFAULT false,
  cooldown_minutes integer NOT NULL DEFAULT 30 CHECK (cooldown_minutes BETWEEN 1 AND 1440),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, id)
);

CREATE TABLE IF NOT EXISTS gymos.whatsapp_audit_logs (
  owner_id text NOT NULL,
  id text NOT NULL,
  branch text NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  detail text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, id)
);

ALTER TABLE gymos.whatsapp_outbox ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'meta';
ALTER TABLE gymos.whatsapp_outbox ADD COLUMN IF NOT EXISTS session_id text;
ALTER TABLE gymos.whatsapp_outbox ADD COLUMN IF NOT EXISTS message_type text NOT NULL DEFAULT 'rule';
ALTER TABLE gymos.whatsapp_outbox ADD COLUMN IF NOT EXISTS scheduled_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE gymos.whatsapp_outbox ADD COLUMN IF NOT EXISTS attempted_at timestamptz;
ALTER TABLE gymos.whatsapp_outbox ADD COLUMN IF NOT EXISTS sent_at timestamptz;
ALTER TABLE gymos.whatsapp_outbox ADD COLUMN IF NOT EXISTS error_code text;
ALTER TABLE gymos.whatsapp_outbox ADD COLUMN IF NOT EXISTS idempotency_key text;

DO $rls$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY[
    'whatsapp_provider_connections',
    'whatsapp_inbox',
    'whatsapp_messages',
    'whatsapp_auto_replies',
    'whatsapp_audit_logs'
  ] LOOP
    EXECUTE format('ALTER TABLE gymos.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE gymos.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON gymos.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON gymos.%I TO gymos_app', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON gymos.%I', t || '_scope', t);
    EXECUTE format(
      'CREATE POLICY %I ON gymos.%I TO gymos_app USING (owner_id = current_setting(''app.gym_owner'', true) OR current_setting(''app.messaging_worker'', true) = ''1'') WITH CHECK (owner_id = current_setting(''app.gym_owner'', true) OR current_setting(''app.messaging_worker'', true) = ''1'')',
      t || '_scope',
      t
    );
  END LOOP;
END $rls$;
