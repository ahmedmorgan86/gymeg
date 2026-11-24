-- Shared member PINs are no longer issued or accepted. Existing accounts that
-- still use one of the historic shared values receive a per-member random PIN.
-- Their old sessions are revoked and a PIN change is required at next sign-in.
-- This migration supersedes the temporary default in 20261023221405.

CREATE OR REPLACE FUNCTION gymos.new_member_pin() RETURNS text LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE bytes bytea;n integer;pin text;shared text[]:=ARRAY['000000','111111','123456','654321'];
BEGIN
 LOOP
  bytes:=sha256(convert_to(gen_random_uuid()::text||gen_random_uuid()::text,'UTF8'));
  n:=get_byte(bytes,0)*65536+get_byte(bytes,1)*256+get_byte(bytes,2);
  IF n<16000000 THEN
   pin:=lpad((n%1000000)::text,6,'0');
   IF NOT (pin=ANY(shared)) THEN RETURN pin;END IF;
  END IF;
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION gymos.sync_member_codes(members jsonb) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,gymos AS $$
DECLARE own text:=current_setting('app.gym_owner',true);m jsonb;phone text;phone_digest text;pin text;old_phone text;old_pin text;
BEGIN
 PERFORM gymos.sync_member_code_accounts(members);
 FOR m IN SELECT e FROM jsonb_array_elements(members) e WHERE NOT coalesce((e->>'demo')::boolean,false) AND NOT coalesce((e->>'archived')::boolean,false) LOOP
  phone:=gymos.normalize_member_phone(m->>'phone');phone_digest:=CASE WHEN phone IS NULL THEN NULL ELSE encode(sha256(convert_to(phone,'UTF8')),'hex') END;
  SELECT phone_hash,pin_hash INTO old_phone,old_pin FROM gymos.member_code_access WHERE owner_id=own AND member_id=m->>'id' FOR UPDATE;
  IF phone_digest IS DISTINCT FROM old_phone OR (phone_digest IS NOT NULL AND old_pin IS NULL) THEN
   IF phone_digest IS NULL THEN UPDATE gymos.member_code_access SET phone_hash=NULL,pin_hash=NULL,pin_cipher=NULL,pin_must_change=true,version=version+1 WHERE owner_id=own AND member_id=m->>'id';
   ELSE pin:=gymos.new_member_pin();UPDATE gymos.member_code_access SET phone_hash=phone_digest,pin_hash=gymos.member_pin_hash(pin),pin_cipher=gymos.member_pin_encrypt(pin),pin_must_change=true,version=version+1 WHERE owner_id=own AND member_id=m->>'id';END IF;
  END IF;
 END LOOP;
END $$;

DO $$
DECLARE s record;target record;pin text;shared text[]:=ARRAY['000000','111111','123456','654321'];
BEGIN
 FOR s IN SELECT user_id FROM gymos.gym_states LOOP
  PERFORM set_config('app.gym_owner',s.user_id,true);
  FOR target IN
   -- The hash is authoritative for PIN verification. Decryption is deliberately
   -- avoided here: legacy ciphertext may be unreadable after a Vault key change,
   -- and it must not block remediation of accounts whose hash matches a shared PIN.
   SELECT a.member_id
   FROM gymos.member_code_access a
   WHERE a.pin_hash IS NOT NULL
     AND EXISTS(SELECT 1 FROM unnest(shared) value WHERE gymos.member_pin_matches(value,a.pin_hash))
  LOOP
   pin:=gymos.new_member_pin();
   UPDATE gymos.member_code_access
      SET pin_hash=gymos.member_pin_hash(pin),pin_cipher=gymos.member_pin_encrypt(pin),pin_must_change=true,version=version+1
    WHERE owner_id=s.user_id AND member_id=target.member_id;
   DELETE FROM gymos.member_code_sessions WHERE owner_id=s.user_id AND member_id=target.member_id;
  END LOOP;
 END LOOP;
END $$;
