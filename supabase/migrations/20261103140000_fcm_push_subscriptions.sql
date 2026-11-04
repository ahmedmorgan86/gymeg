CREATE TABLE gymos.fcm_subscriptions (
 subscription_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 owner_id text NOT NULL REFERENCES gymos.gym_states(user_id) ON DELETE CASCADE,
 branch text NOT NULL CHECK(length(branch) BETWEEN 1 AND 250),
 recipient_type text NOT NULL CHECK(recipient_type IN ('staff','member')),
 recipient_id text NOT NULL CHECK(length(recipient_id) BETWEEN 1 AND 250),
 token_hash text NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 token_ciphertext text NOT NULL CHECK(length(token_ciphertext) BETWEEN 80 AND 6000),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,branch,recipient_type,recipient_id,token_hash)
);
CREATE INDEX fcm_subscriptions_branch_recipient
 ON gymos.fcm_subscriptions(owner_id,branch,recipient_type,recipient_id);
ALTER TABLE gymos.fcm_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.fcm_subscriptions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON gymos.fcm_subscriptions FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON gymos.fcm_subscriptions TO gymos_app;
CREATE POLICY fcm_subscriptions_owner_scope ON gymos.fcm_subscriptions TO gymos_app
 USING(owner_id=current_setting('app.gym_owner',true))
 WITH CHECK(owner_id=current_setting('app.gym_owner',true));

