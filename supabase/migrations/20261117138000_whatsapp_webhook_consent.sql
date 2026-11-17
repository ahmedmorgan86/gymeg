-- B11: durable inbound WhatsApp webhook state. Safe to replay: every object is
-- created IF NOT EXISTS / CREATE OR REPLACE, and all writes are keyed by a
-- deterministic event key so a redelivered webhook has no second effect.
SET lock_timeout='5s';

-- Opt-outs are keyed by owner + phone digest. Meta does not send the stored
-- raw member phone, so only a SHA-256 digest of the normalized number is kept.
-- owner_id='*' is the fail-closed bucket used when a STOP arrives for a phone
-- number id that is not (or no longer) linked to a club connection.
CREATE TABLE IF NOT EXISTS gymos.whatsapp_optouts (
  owner_id text NOT NULL,
  phone_hash text NOT NULL CHECK(phone_hash ~ '^[a-f0-9]{64}$'),
  source text NOT NULL DEFAULT 'webhook_stop',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,phone_hash)
);
CREATE TABLE IF NOT EXISTS gymos.whatsapp_webhook_events (
  event_key text PRIMARY KEY CHECK(event_key ~ '^[a-f0-9]{64}$'),
  kind text NOT NULL CHECK(kind IN ('optout','status')),
  phone_number_id text,
  provider_message_id text,
  status text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE gymos.whatsapp_outbox
  ADD COLUMN IF NOT EXISTS delivery_status text CHECK(delivery_status IN ('sent','delivered','read','failed')),
  ADD COLUMN IF NOT EXISTS delivery_updated_at timestamptz;

ALTER TABLE gymos.whatsapp_optouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.whatsapp_optouts FORCE ROW LEVEL SECURITY;
ALTER TABLE gymos.whatsapp_webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.whatsapp_webhook_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON gymos.whatsapp_optouts,gymos.whatsapp_webhook_events FROM PUBLIC,anon,authenticated;

-- Persist a STOP once per provider message. The owner list comes from the
-- connected phone number id; if none matches, opt out globally rather than
-- silently ignoring the recipient's request.
CREATE OR REPLACE FUNCTION gymos.whatsapp_webhook_stop(
  phone_number_id_in text,phone_hash_in text,event_key_in text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
DECLARE owner_count integer;
BEGIN
  IF phone_hash_in IS NULL OR phone_hash_in !~ '^[a-f0-9]{64}$'
     OR event_key_in IS NULL OR event_key_in !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
  INSERT INTO gymos.whatsapp_webhook_events(event_key,kind,phone_number_id)
  VALUES(event_key_in,'optout',phone_number_id_in) ON CONFLICT(event_key) DO NOTHING;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT count(*) INTO owner_count FROM gymos.whatsapp_connections WHERE phone_id=phone_number_id_in;
  IF owner_count>0 THEN
    INSERT INTO gymos.whatsapp_optouts(owner_id,phone_hash,source)
    SELECT c.owner_id,phone_hash_in,'webhook_stop' FROM gymos.whatsapp_connections c
    WHERE c.phone_id=phone_number_id_in ON CONFLICT(owner_id,phone_hash) DO NOTHING;
  ELSE
    INSERT INTO gymos.whatsapp_optouts(owner_id,phone_hash,source)
    VALUES('*',phone_hash_in,'webhook_stop') ON CONFLICT(owner_id,phone_hash) DO NOTHING;
  END IF;
  RETURN true;
END $$;

-- Provider delivery statuses are recorded on the accepted outbound row via
-- the provider message id returned by the Graph API. Existing send-lifecycle
-- status is not overwritten: provider acceptance is not delivery.
CREATE OR REPLACE FUNCTION gymos.whatsapp_webhook_status(
  provider_id_in text,status_in text,event_key_in text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
BEGIN
  IF provider_id_in IS NULL OR length(provider_id_in)=0 OR length(provider_id_in)>255
     OR status_in IS NULL OR status_in NOT IN ('sent','delivered','read','failed')
     OR event_key_in IS NULL OR event_key_in !~ '^[a-f0-9]{64}$' THEN RETURN false; END IF;
  INSERT INTO gymos.whatsapp_webhook_events(event_key,kind,provider_message_id,status)
  VALUES(event_key_in,'status',provider_id_in,status_in) ON CONFLICT(event_key) DO NOTHING;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE gymos.whatsapp_outbox SET delivery_status=status_in,delivery_updated_at=now()
  WHERE provider_id=provider_id_in;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION gymos.whatsapp_opted_out(owner_in text,phone_hash_in text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,gymos AS $$
  SELECT phone_hash_in ~ '^[a-f0-9]{64}$' AND EXISTS(
    SELECT 1 FROM gymos.whatsapp_optouts o
    WHERE o.phone_hash=phone_hash_in AND (o.owner_id=owner_in OR o.owner_id='*')
  );
$$;
REVOKE ALL ON FUNCTION gymos.whatsapp_webhook_stop(text,text,text),
  gymos.whatsapp_webhook_status(text,text,text),gymos.whatsapp_opted_out(text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION gymos.whatsapp_webhook_stop(text,text,text),
  gymos.whatsapp_webhook_status(text,text,text),gymos.whatsapp_opted_out(text,text)
  TO gymos_app;
