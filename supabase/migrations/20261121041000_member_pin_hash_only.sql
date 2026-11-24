-- Member PINs become hash-only: a PIN is shown to staff exactly once, at
-- creation or reset, and can never be read back afterwards. Existing
-- reversibly-encrypted PINs are dropped; verification uses pin_hash only.
-- Members who only ever had an encrypted PIN keep signing in via pin_hash
-- (the hash column is untouched). No member action is required.
UPDATE gymos.member_code_access SET pin_cipher = NULL WHERE pin_cipher IS NOT NULL;
