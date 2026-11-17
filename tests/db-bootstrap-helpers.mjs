import {readFileSync,readdirSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

export const root=new URL('../',import.meta.url);
export const readFile=name=>readFileSync(new URL(name,root),'utf8');
export const migrationDir=new URL('supabase/migrations/',root);
export const migrationFiles=readdirSync(migrationDir).filter(name=>name.endsWith('.sql')).sort();
export const baseFiles=['db/postgres.sql','db/entities.sql','db/access-events.sql'];

// PGlite does not ship the Supabase-only extensions. These local stubs mirror
// only the signatures the SQL uses; production still requires the real ones.
export const localExtensionStubs=`
CREATE ROLE gymos_app;CREATE ROLE anon;CREATE ROLE authenticated;
CREATE SCHEMA extensions;
CREATE FUNCTION extensions.digest(value text,algorithm text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT CASE WHEN algorithm='sha256' THEN sha256(convert_to(value,'UTF8')) ELSE decode(md5(value),'hex') END $$;
CREATE FUNCTION extensions.gen_random_bytes(n integer) RETURNS bytea LANGUAGE sql VOLATILE AS $$ SELECT substring(sha256(convert_to(gen_random_uuid()::text,'UTF8')) from 1 for greatest(1,least(64,n))) $$;
CREATE FUNCTION extensions.pgp_sym_encrypt(value text,key text,options text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT convert_to(value,'UTF8') $$;
CREATE FUNCTION extensions.pgp_sym_encrypt(value text,key text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT convert_to(value,'UTF8') $$;
CREATE FUNCTION extensions.pgp_sym_decrypt(value bytea,key text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT convert_from(value,'UTF8') $$;
CREATE FUNCTION extensions.gen_salt(algorithm text,cost integer) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'::text $$;
CREATE FUNCTION extensions.crypt(value text,salt text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT salt $$;
CREATE SCHEMA vault;
CREATE TABLE vault.secrets(name text PRIMARY KEY,secret text,description text);
CREATE VIEW vault.decrypted_secrets AS SELECT name,secret AS decrypted_secret FROM vault.secrets;
CREATE FUNCTION vault.create_secret(secret text,name text,description text) RETURNS uuid LANGUAGE sql VOLATILE AS $$ INSERT INTO vault.secrets(name,secret,description) VALUES(name,secret,description) ON CONFLICT(name) DO UPDATE SET secret=excluded.secret RETURNING gen_random_uuid() $$;
CREATE SCHEMA cron;
CREATE TABLE cron.job(jobid bigserial PRIMARY KEY,jobname text UNIQUE,schedule text,command text,active boolean NOT NULL DEFAULT true);
CREATE FUNCTION cron.schedule(jobname text,schedule text,command text) RETURNS bigint LANGUAGE sql VOLATILE AS $$ INSERT INTO cron.job(jobname,schedule,command) VALUES(jobname,schedule,command) ON CONFLICT(jobname) DO UPDATE SET schedule=excluded.schedule,command=excluded.command RETURNING jobid $$;
CREATE FUNCTION cron.alter_job(job_id bigint,schedule text DEFAULT NULL,command text DEFAULT NULL,database text DEFAULT NULL,username text DEFAULT NULL,active boolean DEFAULT NULL) RETURNS void LANGUAGE sql VOLATILE AS $$ UPDATE cron.job AS j SET active=coalesce($6,j.active) WHERE j.jobid=$1 $$;
CREATE SCHEMA net;
CREATE FUNCTION net.http_get(url text,headers jsonb,timeout_milliseconds integer) RETURNS bigint LANGUAGE sql VOLATILE AS $$ SELECT 1::bigint $$;
`;
export const stripUnavailableExtensions=sql=>sql.replace(/^\s*CREATE EXTENSION IF NOT EXISTS (pg_cron|pg_net);\s*$/gm,'-- extension supplied by the platform in production\n');

export async function bootstrapDb({through}={}){
  const db=new PGlite();
  await db.exec(localExtensionStubs);
  for(const file of baseFiles)await db.exec(readFile(file));
  for(const name of migrationFiles){
    if(through&&name>through)break;
    await db.exec(stripUnavailableExtensions(readFile(`supabase/migrations/${name}`)));
  }
  return db;
}
