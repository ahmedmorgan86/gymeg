-- Hash-only PIN writer, completing 20261121041000. The effective
-- gymos.sync_member_codes no longer stores reversible PIN ciphertext when it
-- issues or rotates a PIN (first credential, phone change). Verification is
-- pin_hash-only via gymos.member_pin_matches and is unchanged, so members
-- keep signing in exactly as before. A sync-issued PIN is now unknown to
-- everyone by design; staff issue a known replacement through the existing
-- one-time-show reset route when a member needs access, which is already
-- the post-20261121041000 reality for every cleaned row.
--
-- The runtime role also loses EXECUTE on the decrypt and PIN-encrypt
-- helpers: no application path reads ciphertext any more. Member codes are
-- unaffected - issuance keeps code_cipher via gymos.member_code_encrypt and
-- verification uses code_hash.

CREATE OR REPLACE FUNCTION gymos.sync_member_codes(members jsonb) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,gymos AS $$
DECLARE own text:=current_setting('app.gym_owner',true);m jsonb;phone text;phone_digest text;pin text;old_phone text;old_pin text;
BEGIN
 PERFORM gymos.sync_member_code_accounts(members);
 FOR m IN SELECT e FROM jsonb_array_elements(members) e WHERE NOT coalesce((e->>'demo')::boolean,false) AND NOT coalesce((e->>'archived')::boolean,false) LOOP
  phone:=gymos.normalize_member_phone(m->>'phone');phone_digest:=CASE WHEN phone IS NULL THEN NULL ELSE encode(sha256(convert_to(phone,'UTF8')),'hex') END;
  SELECT phone_hash,pin_hash INTO old_phone,old_pin FROM gymos.member_code_access WHERE owner_id=own AND member_id=m->>'id' FOR UPDATE;
  IF phone_digest IS DISTINCT FROM old_phone OR (phone_digest IS NOT NULL AND old_pin IS NULL) THEN
   IF phone_digest IS NULL THEN UPDATE gymos.member_code_access SET phone_hash=NULL,pin_hash=NULL,pin_cipher=NULL,pin_must_change=true,version=version+1 WHERE owner_id=own AND member_id=m->>'id';
   ELSE pin:=gymos.new_member_pin();UPDATE gymos.member_code_access SET phone_hash=phone_digest,pin_hash=gymos.member_pin_hash(pin),pin_cipher=NULL,pin_must_change=true,version=version+1 WHERE owner_id=own AND member_id=m->>'id';END IF;
  END IF;
 END LOOP;
END $$;

-- Clear ciphertext from rows the old writer produced after 20261121041000 ran.
UPDATE gymos.member_code_access SET pin_cipher=NULL WHERE pin_cipher IS NOT NULL;

REVOKE EXECUTE ON FUNCTION gymos.member_code_decrypt(text) FROM gymos_app;
REVOKE EXECUTE ON FUNCTION gymos.member_pin_encrypt(text) FROM gymos_app;
