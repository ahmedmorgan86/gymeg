-- HELD LOCAL CANDIDATE ONLY. Not a hosted migration. No login/password or job.
BEGIN;
SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='15s';
DO $$BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='gymos_support_business_sender' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication) THEN RAISE EXCEPTION 'safe isolated sender role required'; END IF;
END$$;
CREATE TABLE gymos.support_business_delivery(
 order_id text NOT NULL,event_kind text NOT NULL,recipient_user_id text NOT NULL,
 claim_seq bigint NOT NULL DEFAULT 0,lease_id text,lease_until timestamptz,
 snapshotted boolean NOT NULL DEFAULT false,attempts integer NOT NULL DEFAULT 0,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','sending','accepted','no_recipients','failed')),
 next_retry_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(order_id,event_kind),
 FOREIGN KEY(order_id,event_kind) REFERENCES gymos.support_business_outbox(order_id,event_kind));
CREATE TABLE gymos.support_business_device_delivery(
 order_id text NOT NULL,event_kind text NOT NULL,user_id text NOT NULL,token_hash text NOT NULL,
 -- Exact ciphertext-version digest prevents deleting/accepting a replacement registration.
 token_version text NOT NULL,retry_not_before timestamptz,status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','accepted','invalid','skipped','unknown')),
 PRIMARY KEY(order_id,event_kind,token_hash),
 FOREIGN KEY(order_id,event_kind) REFERENCES gymos.support_business_delivery(order_id,event_kind));
ALTER TABLE gymos.support_business_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.support_business_delivery FORCE ROW LEVEL SECURITY;
ALTER TABLE gymos.support_business_device_delivery ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.support_business_device_delivery FORCE ROW LEVEL SECURITY;
REVOKE ALL ON gymos.support_business_delivery,gymos.support_business_device_delivery FROM PUBLIC,anon,authenticated,gymos_app;
GRANT USAGE ON SCHEMA gymos TO gymos_support_business_sender;
GRANT SELECT ON gymos.support_business_recipient,gymos.support_business_outbox TO gymos_support_business_sender;
GRANT SELECT,INSERT,UPDATE ON gymos.support_business_delivery,gymos.support_business_device_delivery TO gymos_support_business_sender;
GRANT SELECT ON gymos.support_fcm_subscriptions TO gymos_support_business_sender;
GRANT SELECT(user_id) ON gymos.platform_admins TO gymos_support_business_sender;
CREATE POLICY business_sender_config ON gymos.support_business_recipient FOR SELECT TO gymos_support_business_sender USING(true);
CREATE POLICY business_sender_outbox ON gymos.support_business_outbox FOR SELECT TO gymos_support_business_sender USING(recipient_user_id IN(SELECT user_id FROM gymos.support_business_recipient));
CREATE POLICY business_sender_lease ON gymos.support_business_delivery TO gymos_support_business_sender USING(recipient_user_id IN(SELECT user_id FROM gymos.support_business_recipient)) WITH CHECK(recipient_user_id IN(SELECT user_id FROM gymos.support_business_recipient) AND EXISTS(SELECT 1 FROM gymos.support_business_outbox o WHERE o.order_id=support_business_delivery.order_id AND o.event_kind=support_business_delivery.event_kind AND o.recipient_user_id=support_business_delivery.recipient_user_id));
CREATE POLICY business_sender_device ON gymos.support_business_device_delivery TO gymos_support_business_sender USING(user_id IN(SELECT user_id FROM gymos.support_business_recipient)) WITH CHECK(user_id IN(SELECT user_id FROM gymos.support_business_recipient) AND EXISTS(SELECT 1 FROM gymos.support_business_delivery d WHERE d.order_id=support_business_device_delivery.order_id AND d.event_kind=support_business_device_delivery.event_kind AND d.recipient_user_id=support_business_device_delivery.user_id));
CREATE POLICY business_sender_subscription ON gymos.support_fcm_subscriptions FOR SELECT TO gymos_support_business_sender USING(user_id IN(SELECT user_id FROM gymos.support_business_recipient));
CREATE POLICY business_sender_admin ON gymos.platform_admins FOR SELECT TO gymos_support_business_sender USING(user_id IN(SELECT user_id FROM gymos.support_business_recipient));
-- No DELETE subscription privilege. Invalid-token retirement remains unimplemented.
-- Only source ID/status, never source actor/tenant/amount/payload.
GRANT SELECT(id,status) ON gymos.activation_requests TO gymos_support_business_sender;
CREATE POLICY business_sender_source_status ON gymos.activation_requests FOR SELECT TO gymos_support_business_sender USING(EXISTS(SELECT 1 FROM gymos.support_business_outbox o WHERE o.order_id=activation_requests.id AND o.recipient_user_id IN(SELECT user_id FROM gymos.support_business_recipient)));
COMMIT;
