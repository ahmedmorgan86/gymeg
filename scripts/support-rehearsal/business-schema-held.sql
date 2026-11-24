-- REVIEW ONLY. New business tables, not the synthetic acceptance outbox.
-- NO deployment authority. Recipient config must be seeded by migration owner
-- from the independently verified Ahmed account. Runtime cannot edit it.
BEGIN;
SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='15s';
CREATE TABLE gymos.support_business_recipient(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),user_id text NOT NULL);
CREATE TABLE gymos.support_business_outbox(
 order_id text NOT NULL,event_kind text NOT NULL CHECK(event_kind IN('quote_requested','transfer_submitted')),
 recipient_user_id text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','sending','delivered','no_recipients','failed')),
 PRIMARY KEY(order_id,event_kind));
ALTER TABLE gymos.support_business_recipient ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.support_business_recipient FORCE ROW LEVEL SECURITY;
ALTER TABLE gymos.support_business_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.support_business_outbox FORCE ROW LEVEL SECURITY;
REVOKE ALL ON gymos.support_business_recipient,gymos.support_business_outbox FROM PUBLIC,anon,authenticated,gymos_app;
-- Bootstrap this NOLOGIN role separately, with verified non-super/non-bypass
-- attributes. No LOGIN or runtime membership is permitted.
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='gymos_support_enqueue' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication) THEN RAISE EXCEPTION 'safe enqueue role required'; END IF;
END $$;
GRANT USAGE ON SCHEMA gymos TO gymos_support_enqueue;
GRANT SELECT(id,tenant_id,user_id,status) ON gymos.activation_requests TO gymos_support_enqueue;
GRANT SELECT(tenant_id,user_id,role,revoked) ON gymos.tenant_memberships TO gymos_support_enqueue;
GRANT SELECT(user_id) ON gymos.platform_admins TO gymos_support_enqueue;
GRANT SELECT ON gymos.support_business_recipient TO gymos_support_enqueue;
GRANT INSERT ON gymos.support_business_outbox TO gymos_support_enqueue;
CREATE POLICY support_enqueue_request ON gymos.activation_requests FOR SELECT TO gymos_support_enqueue USING(user_id=current_setting('app.actor',true));
CREATE POLICY support_enqueue_membership ON gymos.tenant_memberships FOR SELECT TO gymos_support_enqueue USING(user_id=current_setting('app.actor',true) AND role='owner' AND NOT revoked);
CREATE POLICY support_enqueue_admin ON gymos.platform_admins FOR SELECT TO gymos_support_enqueue USING(user_id IN(SELECT user_id FROM gymos.support_business_recipient WHERE singleton));
CREATE POLICY support_enqueue_config ON gymos.support_business_recipient FOR SELECT TO gymos_support_enqueue USING(true);
CREATE POLICY support_enqueue_append ON gymos.support_business_outbox FOR INSERT TO gymos_support_enqueue WITH CHECK(recipient_user_id IN(SELECT user_id FROM gymos.support_business_recipient WHERE singleton));
CREATE FUNCTION gymos.support_business_alert_enqueue(p_order text,p_event text,p_recipient text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE r record; actor text; expected_status text;
BEGIN
 actor:=current_setting('app.actor',true);
 IF actor IS NULL OR actor='' OR p_event IS NULL OR p_event NOT IN('quote_requested','transfer_submitted') THEN RAISE EXCEPTION 'invalid support event' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS(SELECT 1 FROM gymos.support_business_recipient c JOIN gymos.platform_admins a ON a.user_id=c.user_id WHERE c.singleton AND c.user_id=p_recipient) THEN RAISE EXCEPTION 'support recipient not configured' USING ERRCODE='42501'; END IF;
 SELECT tenant_id,user_id,status INTO r FROM gymos.activation_requests WHERE id=p_order;
 expected_status:=CASE p_event WHEN 'quote_requested' THEN 'quote_requested' ELSE 'pending_review' END;
 IF NOT FOUND OR r.user_id IS DISTINCT FROM actor OR r.status IS DISTINCT FROM expected_status OR NOT EXISTS(SELECT 1 FROM gymos.tenant_memberships m WHERE m.tenant_id=r.tenant_id AND m.user_id=actor AND m.role='owner' AND NOT m.revoked) THEN RAISE EXCEPTION 'support event source denied' USING ERRCODE='42501'; END IF;
 INSERT INTO gymos.support_business_outbox(order_id,event_kind,recipient_user_id) VALUES(p_order,p_event,p_recipient) ON CONFLICT DO NOTHING;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION gymos.support_business_alert_enqueue(text,text,text) FROM PUBLIC,anon,authenticated;
-- Provider-safe transfer needs temporary SET membership + schema CREATE, removed
-- in this same transaction. This artifact must run only as migration identity.
GRANT gymos_support_enqueue TO CURRENT_USER;
GRANT CREATE ON SCHEMA gymos TO gymos_support_enqueue;
GRANT EXECUTE ON FUNCTION gymos.support_business_alert_enqueue(text,text,text) TO gymos_app;
ALTER FUNCTION gymos.support_business_alert_enqueue(text,text,text) OWNER TO gymos_support_enqueue;
REVOKE CREATE ON SCHEMA gymos FROM gymos_support_enqueue;
REVOKE gymos_support_enqueue FROM CURRENT_USER;
-- No sender login, job, host, token, HTTP call or real message is created.
COMMIT;
