-- Register the support Android shell as a handoff client. The shell ports
-- the management app's verified system-browser OAuth flow; the server side
-- only needs the client tag widened. Code/challenge/session semantics are
-- unchanged.
ALTER TABLE gymos.auth_handoff_codes DROP CONSTRAINT IF EXISTS auth_handoff_codes_client_check;
ALTER TABLE gymos.auth_handoff_codes ADD CONSTRAINT auth_handoff_codes_client_check
  CHECK(client IN ('android-members','android-management','android-support'));
