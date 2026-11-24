-- HELD, review only. Synthetic isolated project only, not production migration.
-- Requires approved role/bootstrap and preflight catalog inspection separately.
-- DO NOT run through application runtime or base migration runner.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='15s';
DO $$ BEGIN
 IF current_database()<>'postgres' OR to_regclass('gymos.support_fcm_subscriptions') IS NULL OR to_regclass('gymos.platform_admins') IS NULL THEN
  RAISE EXCEPTION 'expected isolated provider schema missing';
 END IF;
 -- This is a second guard, not authentication. Runner MUST independently pin
 -- the isolated connection ref REVIEW_REQUIRED_SYNTHETIC_PROJECT, verify TLS and confirm target.
 IF current_setting('app.support_rehearsal_target',true) IS DISTINCT FROM 'REVIEW_REQUIRED_SYNTHETIC_PROJECT' THEN RAISE EXCEPTION 'isolated target guard missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='gymos_support_sender' AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolcanlogin) THEN
  RAISE EXCEPTION 'separately approved safe NOLOGIN sender role required';
 END IF;
END $$;
CREATE TABLE gymos.support_alert_outbox(
 event_id text PRIMARY KEY CHECK(event_id ~ '^synthetic:[a-zA-Z0-9-]{16,100}$'),
 kind text NOT NULL CHECK(kind='synthetic.acceptance'),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','sending','no_recipients','delivered','delivered_none','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), claim_seq integer NOT NULL DEFAULT 0 CHECK(claim_seq>=0),
 claimed_by text,claimed_at timestamptz,next_retry_at timestamptz NOT NULL DEFAULT now(),
 last_error text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE gymos.support_alert_recipients(
 event_id text NOT NULL REFERENCES gymos.support_alert_outbox(event_id),user_id text NOT NULL,token_hash text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','sent','gone','ineligible','undeliverable','dropped')),
 PRIMARY KEY(event_id,token_hash));
ALTER TABLE gymos.support_alert_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.support_alert_outbox FORCE ROW LEVEL SECURITY;
ALTER TABLE gymos.support_alert_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.support_alert_recipients FORCE ROW LEVEL SECURITY;
REVOKE ALL ON gymos.support_alert_outbox,gymos.support_alert_recipients FROM PUBLIC,anon,authenticated,gymos_app;
GRANT USAGE ON SCHEMA gymos TO gymos_support_sender;
GRANT SELECT ON gymos.platform_admins,gymos.support_fcm_subscriptions TO gymos_support_sender;
GRANT DELETE ON gymos.support_fcm_subscriptions TO gymos_support_sender;
GRANT SELECT,INSERT,UPDATE ON gymos.support_alert_outbox,gymos.support_alert_recipients TO gymos_support_sender;
CREATE POLICY support_rehearsal_sender_admins ON gymos.platform_admins FOR SELECT TO gymos_support_sender USING(true);
CREATE POLICY support_rehearsal_sender_subs_sel ON gymos.support_fcm_subscriptions FOR SELECT TO gymos_support_sender USING(true);
CREATE POLICY support_rehearsal_sender_subs_del ON gymos.support_fcm_subscriptions FOR DELETE TO gymos_support_sender USING(true);
CREATE POLICY support_rehearsal_sender_outbox ON gymos.support_alert_outbox FOR ALL TO gymos_support_sender USING(true) WITH CHECK(true);
CREATE POLICY support_rehearsal_sender_recipients ON gymos.support_alert_recipients FOR ALL TO gymos_support_sender USING(true) WITH CHECK(true);
CREATE FUNCTION gymos.support_alert_enqueue(p_event_id text,p_kind text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF p_event_id IS NULL OR p_event_id !~ '^synthetic:[a-zA-Z0-9-]{16,100}$' OR p_kind IS DISTINCT FROM 'synthetic.acceptance' THEN
  RAISE EXCEPTION 'synthetic event required' USING ERRCODE='22023';
 END IF;
 INSERT INTO gymos.support_alert_outbox(event_id,kind) VALUES(p_event_id,p_kind) ON CONFLICT(event_id) DO NOTHING;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION gymos.support_alert_enqueue(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION gymos.support_alert_enqueue(text,text) TO gymos_app;
-- Definer remains migration owner here. A production least-privilege owner and
-- accepted provider-safe ownership transfer must be reviewed before deployment.
-- No automatic cron creation, LOGIN password, FCM config or business hook.
COMMIT;
