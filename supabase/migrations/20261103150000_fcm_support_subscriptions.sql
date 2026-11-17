-- Platform support accounts do not belong to one club/branch. Keep their
-- device tokens user-scoped in a separate table, using the runtime scope key.
CREATE TABLE gymos.support_fcm_subscriptions (
 user_id text NOT NULL CHECK(length(user_id) BETWEEN 1 AND 250),
 token_hash text NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'),
 token_ciphertext text NOT NULL CHECK(length(token_ciphertext) BETWEEN 80 AND 6000),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,token_hash)
);
ALTER TABLE gymos.support_fcm_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.support_fcm_subscriptions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON gymos.support_fcm_subscriptions FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON gymos.support_fcm_subscriptions TO gymos_app;
CREATE POLICY support_fcm_user_scope ON gymos.support_fcm_subscriptions TO gymos_app
 USING(user_id=current_setting('app.gym_owner',true))
 WITH CHECK(user_id=current_setting('app.gym_owner',true));
