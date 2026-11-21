// REHEARSAL SCRIPT, NOT RUN BY THE SUITE. Real PostgreSQL in a rehearsal_ database only. Models the TARGET privileges: every gymos table, sequence and SECURITY DEFINER function
// is owned by a NOSUPERUSER BYPASSRLS maintenance role (the target `postgres`), the runtime is gymos_app (NOSUPERUSER NOBYPASSRLS, owns nothing).
// Checks: FORCE RLS on every new table, runtime writes bump the change token and dirty marks through the definers, other owners see nothing, and NO definer function
// (arbitrary-owner backfill included) is executable by PUBLIC, anon or authenticated.
import pg from 'pg';import assert from 'node:assert/strict';
const url=process.env.REHEARSAL_DATABASE_URL??'';let name='';try{name=decodeURIComponent(new URL(url).pathname.replace(/^\//,''));}catch{}
if(!/^rehearsal_/.test(name)){console.error('refusing: REHEARSAL_DATABASE_URL must name a database starting with "rehearsal_"');process.exit(2);}
const c=new pg.Client({connectionString:url});await c.connect();
await c.query(`DO $$ DECLARE r record; BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='tgtowner') THEN CREATE ROLE tgtowner NOSUPERUSER BYPASSRLS; END IF; GRANT ALL ON SCHEMA gymos TO tgtowner;
 FOR r IN SELECT oid::regprocedure f FROM pg_proc WHERE pronamespace='gymos'::regnamespace AND prosecdef LOOP EXECUTE 'ALTER FUNCTION '||r.f||' OWNER TO tgtowner'; END LOOP;
 FOR r IN SELECT c.oid::regclass t FROM pg_class c WHERE c.relnamespace='gymos'::regnamespace AND c.relkind='r' LOOP EXECUTE 'ALTER TABLE '||r.t||' OWNER TO tgtowner'; END LOOP;
 FOR r IN SELECT c.oid::regclass t FROM pg_class c WHERE c.relnamespace='gymos'::regnamespace AND c.relkind='S' LOOP EXECUTE 'ALTER SEQUENCE '||r.t||' OWNER TO tgtowner'; END LOOP; END $$`);
const q=async(s,v)=>(await c.query(s,v)).rows;
const role=(await q("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname='gymos_app'"))[0];assert.deepEqual(role,{rolsuper:false,rolbypassrls:false});
for(const t of ['gym_owner_version','gym_member_summaries','gym_member_summary_dirty','gym_member_summary_ready']){const r=(await q("SELECT relrowsecurity,relforcerowsecurity,pg_get_userbyid(relowner) AS o FROM pg_class WHERE oid=('gymos.'||$1)::regclass",[t]))[0];assert.deepEqual(r,{relrowsecurity:true,relforcerowsecurity:true,o:'tgtowner'},t+' ENABLE+FORCE RLS, owned by the maintenance role');}
// this work's definers (counters, summary inputs, change version); older definers (member login, messaging, ...) are intentionally runtime-callable and out of scope here
const defs=await q("SELECT oid::regprocedure::text AS f FROM pg_proc WHERE pronamespace='gymos'::regnamespace AND prosecdef AND (proname ~ 'counter|member_summar|owner_version')");assert.ok(defs.length>=12,'found '+defs.length);
for(const {f} of defs)for(const who of ['gymos_app','anon','authenticated']){
  const x=(await q("SELECT CASE WHEN EXISTS(SELECT 1 FROM pg_roles WHERE rolname=$2) THEN has_function_privilege($2,$1::regprocedure,'EXECUTE') ELSE false END AS x",[f,who]))[0].x;
  assert.equal(x,false,who+' must not execute '+f);
}
assert.equal((await q("SELECT has_function_privilege('gymos_app','gymos.backfill_member_summaries(text)','EXECUTE') AS x"))[0].x,false);
console.log('PASS definer functions: none executable by anon/authenticated; arbitrary-owner backfill not executable by gymos_app');
await c.query('DELETE FROM gymos.gym_owner_version WHERE true');
await c.query('BEGIN');await c.query('SET LOCAL ROLE gymos_app');await c.query("SELECT set_config('app.gym_owner','tr-1',true)");
await c.query("INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES('tr-1','{}',1,'x')");
await c.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES('tr-1','members','m',0,'a','{}')");
const tok=(await q("SELECT version FROM gymos.gym_owner_version"));const dirty=(await q("SELECT count(*)::int AS n FROM gymos.gym_member_summary_dirty"))[0].n;
assert.equal(tok.length,1);assert.equal(dirty,1);
await c.query("SELECT set_config('app.gym_owner','tr-2',true)");assert.equal((await q("SELECT count(*)::int AS n FROM gymos.gym_owner_version"))[0].n,0,'another owner sees no token');
await assert.rejects(()=>c.query("INSERT INTO gymos.gym_owner_version VALUES('tr-1',1)"),/permission denied|row-level security/);
await c.query('ROLLBACK');
console.log('PASS runtime writes bump token and dirty marks via definers; cross-owner read empty; direct token write refused');
await c.query("DELETE FROM gymos.gym_entities WHERE owner_id='tr-1'");await c.query("DELETE FROM gymos.gym_states WHERE user_id='tr-1'");await c.end();
