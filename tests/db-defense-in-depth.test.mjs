import {test} from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const migration=readFileSync(new URL('../supabase/migrations/20261117130000_db_defense_in_depth.sql',import.meta.url),'utf8');
const setup=`CREATE SCHEMA gymos;CREATE ROLE gymos_app;CREATE ROLE anon;CREATE ROLE authenticated;GRANT USAGE ON SCHEMA gymos TO gymos_app;
CREATE TABLE gymos.member_portal_access(owner_id text,member_id text,branch text,user_id text,email text,invite_hash text,expires_at timestamptz,revoked boolean NOT NULL DEFAULT false,PRIMARY KEY(owner_id,member_id));
ALTER TABLE gymos.member_portal_access ENABLE ROW LEVEL SECURITY;ALTER TABLE gymos.member_portal_access FORCE ROW LEVEL SECURITY;
CREATE POLICY member_portal_read ON gymos.member_portal_access FOR SELECT TO gymos_app USING(owner_id=current_setting('app.gym_owner',true) OR (user_id=current_setting('app.actor',true) AND NOT revoked));
GRANT SELECT,UPDATE ON gymos.member_portal_access TO gymos_app;
CREATE TABLE gymos.member_code_access(owner_id text,member_id text,branch text,version integer NOT NULL DEFAULT 1,revoked boolean NOT NULL DEFAULT false,inactive boolean NOT NULL DEFAULT false,phone_hash text,pin_hash text,pin_cipher text,pin_must_change boolean NOT NULL DEFAULT true,PRIMARY KEY(owner_id,member_id));
ALTER TABLE gymos.member_code_access ENABLE ROW LEVEL SECURITY;ALTER TABLE gymos.member_code_access FORCE ROW LEVEL SECURITY;
CREATE POLICY member_phone_login ON gymos.member_code_access FOR SELECT TO gymos_app USING(phone_hash=current_setting('app.member_phone',true));
GRANT SELECT ON gymos.member_code_access TO gymos_app;
CREATE OR REPLACE FUNCTION gymos.member_pin_matches(value text,encoded text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT value=encoded $$;
GRANT EXECUTE ON FUNCTION gymos.member_pin_matches(text,text) TO gymos_app;
CREATE TABLE gymos.tenants(id text PRIMARY KEY,storage_key text UNIQUE,name text);
GRANT SELECT,UPDATE ON gymos.tenants TO gymos_app;
CREATE TABLE gymos.tenant_licenses(tenant_id text,plan_id text,mode text,status text,starts_at timestamptz,ends_at timestamptz,limits jsonb);
CREATE TABLE gymos.tenant_memberships(tenant_id text,user_id text,role text,branches jsonb,name text,revoked boolean,PRIMARY KEY(tenant_id,user_id));
GRANT SELECT ON gymos.tenant_licenses TO gymos_app;
GRANT SELECT,INSERT,UPDATE ON gymos.tenant_memberships TO gymos_app;
CREATE TABLE gymos.gym_states(user_id text PRIMARY KEY,state jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE TABLE gymos.gym_access(owner_id text,user_id text,name text,role text,branches text,revoked integer NOT NULL DEFAULT 0,PRIMARY KEY(owner_id,user_id));
CREATE TABLE gymos.gym_invites(owner_id text,token_hash text PRIMARY KEY);
CREATE TABLE gymos.gym_recovery(owner_id text PRIMARY KEY,secret text);
ALTER TABLE gymos.gym_states ENABLE ROW LEVEL SECURITY;ALTER TABLE gymos.gym_states FORCE ROW LEVEL SECURITY;
ALTER TABLE gymos.gym_access ENABLE ROW LEVEL SECURITY;ALTER TABLE gymos.gym_access FORCE ROW LEVEL SECURITY;
ALTER TABLE gymos.gym_invites ENABLE ROW LEVEL SECURITY;ALTER TABLE gymos.gym_invites FORCE ROW LEVEL SECURITY;
ALTER TABLE gymos.gym_recovery ENABLE ROW LEVEL SECURITY;ALTER TABLE gymos.gym_recovery FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON gymos.gym_states,gymos.gym_access,gymos.gym_invites,gymos.gym_recovery TO gymos_app;
CREATE OR REPLACE FUNCTION gymos.sync_tenant_staff() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER sync_tenant_staff AFTER INSERT OR UPDATE ON gymos.gym_access FOR EACH ROW EXECUTE FUNCTION gymos.sync_tenant_staff();`;

test('Defense-in-depth migration is replay-safe and closes member, phone, tenant and branch escape paths',async()=>{
  const db=new PGlite();
  try{
    await db.exec(setup);
    await db.exec(migration);
    await db.exec(migration);
    await db.exec("SET ROLE gymos_app;SELECT set_config('app.gym_owner','owner-a',false),set_config('app.actor','',false)");
    await db.query("INSERT INTO gymos.gym_states(user_id) VALUES('owner-a')");
    await db.query("INSERT INTO gymos.gym_access(owner_id,user_id,role) VALUES('owner-a','staff-a','manager')");
    await assert.rejects(()=>db.query("INSERT INTO gymos.gym_states(user_id) VALUES('owner-b')"),/row-level security/);
    await assert.rejects(()=>db.query("INSERT INTO gymos.gym_access(owner_id,user_id) VALUES('owner-b','staff-b')"),/row-level security/);
    await db.query("SELECT set_config('app.gym_owner','owner-b',false)");
    assert.equal((await db.query('SELECT count(*)::int AS n FROM gymos.gym_states')).rows[0].n,0);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM gymos.gym_access')).rows[0].n,0);
    await db.exec('RESET ROLE');

    await db.query("INSERT INTO gymos.member_portal_access(owner_id,member_id,branch,user_id,email,expires_at) VALUES('owner-a','m1','main','user-a','member@example.invalid',now()+interval '1 hour')");
    await db.exec("SET ROLE gymos_app;SELECT set_config('app.gym_owner','',false),set_config('app.actor','user-a',false),set_config('app.member_invite','',false)");
    await assert.rejects(()=>db.query("UPDATE gymos.member_portal_access SET email='evil@example.invalid' WHERE owner_id='owner-a' AND member_id='m1'"),/memberPortalIdentityImmutable/);
    await assert.rejects(()=>db.query("UPDATE gymos.member_portal_access SET branch='other' WHERE owner_id='owner-a' AND member_id='m1'"),/memberPortalIdentityImmutable/);
    await db.exec("SELECT set_config('app.gym_owner','owner-a',false),set_config('app.actor','',false)");
    await db.query("UPDATE gymos.member_portal_access SET branch='other' WHERE owner_id='owner-a' AND member_id='m1'");
    assert.equal((await db.query("SELECT branch FROM gymos.member_portal_access WHERE member_id='m1'")).rows[0].branch,'other');
    await db.exec('RESET ROLE');

    await db.query("INSERT INTO gymos.member_code_access(owner_id,member_id,branch,version,phone_hash,pin_hash,pin_cipher) VALUES('owner-a','m1','main',1,$1,'123789','cipher')",['a'.repeat(64)]);
    await db.exec('SET ROLE gymos_app');
    await db.query("SELECT set_config('app.gym_owner','',false),set_config('app.actor','',false),set_config('app.member_phone',$1,false)",['a'.repeat(64)]);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM gymos.member_code_access')).rows[0].n,0);
    const safe=(await db.query('SELECT * FROM gymos.member_phone_login($1,$2)',['a'.repeat(64),'123789'])).rows[0];
    assert.deepEqual(Object.keys(safe).sort(),['branch','matches','member_id','owner_id','pin_must_change','version']);
    assert.equal(safe.matches,true);
    assert.equal(safe.pin_must_change,true);
    assert.equal((await db.query('SELECT * FROM gymos.member_phone_login($1,$2)',['a'.repeat(64),'000000'])).rows[0].matches,false);
    await db.exec('RESET ROLE');

    await db.query("INSERT INTO gymos.tenants(id,storage_key,name) VALUES('tenant-a','owner-a','Club A')");
    await db.exec("SET ROLE gymos_app;SELECT set_config('app.tenant','tenant-a',false),set_config('app.platform','',false)");
    await assert.rejects(()=>db.query("UPDATE gymos.tenants SET storage_key='owner-b' WHERE id='tenant-a'"),/tenantStorageKeyImmutable/);
    await db.query("UPDATE gymos.tenants SET name='Renamed' WHERE id='tenant-a'");
    await db.query("SELECT set_config('app.platform','1',false)");
    await db.query("UPDATE gymos.tenants SET storage_key='owner-b' WHERE id='tenant-a'");
    await db.exec('RESET ROLE');

    await db.query("INSERT INTO gymos.tenant_licenses(tenant_id,plan_id,mode,status,starts_at,limits) VALUES('tenant-a','legacy','perpetual','active',now(),'{\"staff\":5}')");
    await db.query("INSERT INTO gymos.gym_access(owner_id,user_id,name,role,branches) VALUES('owner-b','staff-b','B','manager','not-json')");
    const membership=(await db.query("SELECT branches FROM gymos.tenant_memberships WHERE tenant_id='tenant-a' AND user_id='staff-b'")).rows[0];
    assert.deepEqual(membership.branches,[],'malformed staff grants must fail closed to no branches');
  }finally{await db.close();}
});
