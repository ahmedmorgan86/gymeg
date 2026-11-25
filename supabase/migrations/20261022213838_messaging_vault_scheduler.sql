-- Narrow private definer functions bridge the backend runtime to Vault; no client role gets Vault access.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE OR REPLACE FUNCTION gymos._messaging_key(target_branch text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos,extensions AS $$
DECLARE owner_key text:=current_setting('app.gym_owner',true); secret_name text; key_value text;
BEGIN
 IF owner_key IS NULL OR owner_key='' OR NOT EXISTS(SELECT 1 FROM gymos.gym_states s CROSS JOIN LATERAL jsonb_array_elements(s.payload::jsonb->'branches') b WHERE s.user_id=owner_key AND b->>'id'=target_branch) THEN RAISE EXCEPTION 'forbidden'; END IF;
 secret_name:='gymos_whatsapp_'||encode(extensions.digest(owner_key||'|'||target_branch,'sha256'),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended(secret_name,0));
 SELECT decrypted_secret INTO key_value FROM vault.decrypted_secrets WHERE name=secret_name;
 IF key_value IS NULL THEN key_value:=encode(extensions.gen_random_bytes(32),'hex');PERFORM vault.create_secret(key_value,secret_name,'GYM OS branch-scoped WhatsApp encryption key');END IF;
 RETURN key_value;
END $$;
CREATE OR REPLACE FUNCTION gymos.messaging_encrypt(target_branch text,token text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos,extensions AS $$
BEGIN
 IF length(token)<20 OR length(token)>5000 THEN RAISE EXCEPTION 'invalid';END IF;
 RETURN encode(extensions.pgp_sym_encrypt(token,gymos._messaging_key(target_branch),'cipher-algo=aes256,compress-algo=0'),'base64');
END $$;
CREATE OR REPLACE FUNCTION gymos.messaging_decrypt(target_branch text,cipher text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gymos,extensions AS $$
BEGIN RETURN extensions.pgp_sym_decrypt(decode(cipher,'base64'),gymos._messaging_key(target_branch));END $$;
REVOKE ALL ON FUNCTION gymos._messaging_key(text) FROM PUBLIC,anon,authenticated,gymos_app;
REVOKE ALL ON FUNCTION gymos.messaging_encrypt(text,text),gymos.messaging_decrypt(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION gymos.messaging_encrypt(text,text),gymos.messaging_decrypt(text,text) TO gymos_app;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM vault.secrets WHERE name='gymos_whatsapp_cron') THEN PERFORM vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),'gymos_whatsapp_cron','GYM OS scheduled worker authentication');END IF;END $$;
CREATE OR REPLACE FUNCTION gymos.messaging_cron_valid(token text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,extensions AS $$
 SELECT length(token)=64 AND extensions.digest(token,'sha256')=extensions.digest(decrypted_secret,'sha256') FROM vault.decrypted_secrets WHERE name='gymos_whatsapp_cron'
$$;
REVOKE ALL ON FUNCTION gymos.messaging_cron_valid(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION gymos.messaging_cron_valid(text) TO gymos_app;
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='gymos' AND table_name='whatsapp_connections' AND column_name='last_run_at') THEN ALTER TABLE gymos.whatsapp_connections ADD COLUMN last_run_at timestamptz; END IF; END $$;
-- A named schedule upserts the caller's job and returns its ID. The migration
-- transaction keeps the schedule and deactivation invisible until both succeed.
CREATE OR REPLACE FUNCTION gymos.cron_install_disabled(p_name text,p_schedule text,p_command text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
DECLARE v_job bigint;
BEGIN
 IF to_regnamespace('cron') IS NULL THEN RETURN; END IF;
 SELECT cron.schedule(p_name,p_schedule,p_command) INTO STRICT v_job;
 PERFORM cron.alter_job(v_job,active=>false);
END $$;
REVOKE ALL ON FUNCTION gymos.cron_install_disabled(text,text,text) FROM PUBLIC,anon,authenticated,gymos_app;

-- Install disabled; enable only after the matching production route is deployed.
DO $$
DECLARE job_url text; cron_secret text;
BEGIN
 IF to_regnamespace('cron') IS NULL THEN RETURN; END IF;
 IF to_regclass('vault.decrypted_secrets') IS NOT NULL THEN
  SELECT decrypted_secret INTO job_url FROM vault.decrypted_secrets WHERE name='gymos_whatsapp_cron_url';
  SELECT decrypted_secret INTO cron_secret FROM vault.decrypted_secrets WHERE name='gymos_whatsapp_cron';
 END IF;
 job_url:=coalesce(job_url,current_setting('app.whatsapp_cron_url',true),'https://gymos-enterprise.vercel.app');
 PERFORM gymos.cron_install_disabled('gymos-whatsapp-worker','*/5 * * * *',format($job$SELECT net.http_get(url:=%L,headers:=jsonb_build_object('Authorization','Bearer '||%L),timeout_milliseconds:=55000);$job$,job_url||'/api/cron/whatsapp',coalesce(cron_secret,'')));
END $$;
