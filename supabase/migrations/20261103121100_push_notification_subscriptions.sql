CREATE TABLE gymos.push_subscriptions (
 subscription_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id text NOT NULL REFERENCES gymos.gym_states(user_id) ON DELETE CASCADE,
 branch text NOT NULL CHECK(length(branch) BETWEEN 1 AND 250),
 recipient_type text NOT NULL CHECK(recipient_type IN ('staff','member')),
 recipient_id text NOT NULL CHECK(length(recipient_id) BETWEEN 1 AND 250),
 endpoint_hash text NOT NULL CHECK(endpoint_hash ~ '^[a-f0-9]{64}$'),
 subscription_ciphertext text NOT NULL CHECK(length(subscription_ciphertext) BETWEEN 80 AND 12000),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,branch,recipient_type,recipient_id,endpoint_hash)
);
CREATE INDEX push_subscriptions_branch_recipient
 ON gymos.push_subscriptions(owner_id,branch,recipient_type,recipient_id);
ALTER TABLE gymos.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.push_subscriptions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON gymos.push_subscriptions FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON gymos.push_subscriptions TO gymos_app;
CREATE POLICY push_subscriptions_owner_scope ON gymos.push_subscriptions TO gymos_app
 USING(owner_id=current_setting('app.gym_owner',true))
 WITH CHECK(owner_id=current_setting('app.gym_owner',true));
