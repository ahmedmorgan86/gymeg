-- Single-use OAuth session handoff codes for the Android shells.
-- The Android apps run Google sign-in in the system browser; the callback
-- cannot set the WebView's cookie directly, so it stores the validated,
-- encoded gymos_session value here behind a single-use, two-minute code.
-- The row also carries the SHA-256 challenge of the app-generated verifier,
-- binding the exchange to the app instance that started the flow.
-- Not tenant-scoped: rows live only between the callback and the exchange.
CREATE TABLE IF NOT EXISTS gymos.auth_handoff_codes (
  code_hash text PRIMARY KEY CHECK(code_hash ~ '^[a-f0-9]{64}$'),
  session text NOT NULL,
  app_challenge text NOT NULL CHECK(app_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  client text NOT NULL CHECK(client IN ('android-members','android-management')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE gymos.auth_handoff_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.auth_handoff_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_handoff_codes_app ON gymos.auth_handoff_codes TO gymos_app USING(true) WITH CHECK(true);
REVOKE ALL ON gymos.auth_handoff_codes FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,DELETE ON gymos.auth_handoff_codes TO gymos_app;
