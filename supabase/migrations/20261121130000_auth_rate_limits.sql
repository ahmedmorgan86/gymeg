-- Shared auth rate-limit counters for Postgres-backed deployments.
-- Firestore stores these in auth_rate_limits documents when Firestore is the
-- persistence backend; with GYMOS_DATA_BACKEND=postgres this table takes over
-- so the fresh Supabase build has no Firestore dependency outside FCM push.
CREATE TABLE IF NOT EXISTS gymos.auth_rate_limits (
  key_hash text PRIMARY KEY CHECK(key_hash ~ '^[a-f0-9]{64}$'),
  hits integer NOT NULL CHECK(hits > 0),
  reset_at timestamptz NOT NULL
);
-- Not tenant-scoped: counters are per (scope, IP, email) across the platform.
ALTER TABLE gymos.auth_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.auth_rate_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_rate_limits_app ON gymos.auth_rate_limits TO gymos_app USING(true) WITH CHECK(true);
REVOKE ALL ON gymos.auth_rate_limits FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON gymos.auth_rate_limits TO gymos_app;
