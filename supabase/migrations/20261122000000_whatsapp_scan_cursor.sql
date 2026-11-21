-- HELD DRAFT. No outbound schedule is created. Apply only with explicit rollout.
-- Enumeration progress is separate from delivery status; one bounded page/rule
-- advances atomically with deterministic outbox rows in an owner transaction.
CREATE TABLE IF NOT EXISTS gymos.whatsapp_scan_cursor (
 owner_id text NOT NULL REFERENCES gymos.gym_states(user_id) ON DELETE CASCADE,
 rule_id text NOT NULL,
 cursor jsonb,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,rule_id)
);
ALTER TABLE gymos.whatsapp_scan_cursor ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.whatsapp_scan_cursor FORCE ROW LEVEL SECURITY;
REVOKE ALL ON gymos.whatsapp_scan_cursor FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON gymos.whatsapp_scan_cursor TO gymos_app;
CREATE POLICY whatsapp_scan_cursor_owner ON gymos.whatsapp_scan_cursor TO gymos_app
 USING(owner_id=current_setting('app.gym_owner',true))
 WITH CHECK(owner_id=current_setting('app.gym_owner',true));
