import {test,after} from 'node:test';import assert from 'node:assert/strict';import pg from 'pg';const c=new pg.Client({connectionString:'postgresql://supabase_admin@localhost:55434/rehearsal_roles'});await c.connect();const db={exec:s=>c.query(s)};after(()=>c.end());
test('a pre-existing maintenance role is rejected unless exactly safe (re-running the preflight fails closed)',async()=>{
  const sql=(await import('node:fs')).readFileSync(new URL('../supabase/migrations/20261122030000_invoice_allocation_refs.sql',import.meta.url),'utf8');
  const pre=sql.slice(sql.indexOf('DO $r$'),sql.indexOf('END $r$;')+8);
  const run=()=>db.exec(pre);
  await c.query("SET ROLE postgres");await run();await c.query("RESET ROLE"); // provider admin edge accepted
  const bad=async(setup,undo,re)=>{await c.query('BEGIN');try{await c.query(setup);await c.query('SET LOCAL ROLE postgres');await assert.rejects(run,re);}finally{await c.query('ROLLBACK');}};
  await bad("GRANT gymos_refs_maint TO postgres WITH SET TRUE, INHERIT FALSE","",/memberships/);
  await bad("GRANT gymos_refs_maint TO postgres WITH SET FALSE, INHERIT TRUE","",/memberships/);
  await bad("GRANT gymos_refs_maint TO postgres WITH ADMIN FALSE, SET FALSE, INHERIT FALSE","",/memberships/);
  await bad("ALTER ROLE gymos_refs_maint LOGIN","ALTER ROLE gymos_refs_maint NOLOGIN",/unsafe attributes/);
  await bad("ALTER ROLE gymos_refs_maint INHERIT","ALTER ROLE gymos_refs_maint NOINHERIT",/unsafe attributes/);
  await bad("ALTER ROLE gymos_refs_maint CREATEDB","ALTER ROLE gymos_refs_maint NOCREATEDB",/unsafe attributes/);
  await bad("CREATE ROLE rr_member; GRANT rr_member TO gymos_refs_maint","REVOKE rr_member FROM gymos_refs_maint; DROP ROLE rr_member",/memberships/);
  await bad("GRANT gymos_refs_maint TO gymos_app","REVOKE gymos_refs_maint FROM gymos_app",/memberships/);
  await bad("CREATE TABLE gymos.rr_owned(a int); ALTER TABLE gymos.rr_owned OWNER TO gymos_refs_maint","DROP TABLE gymos.rr_owned",/unrelated ownership, ACL/);
  await bad("CREATE TABLE gymos.rr_priv(a int); GRANT SELECT ON gymos.rr_priv TO gymos_refs_maint","DROP TABLE gymos.rr_priv",/unrelated ownership, ACL/);
  // effective-privilege coverage the visible-table-grants check missed: column ACL, grant option, function overload ownership, schema privilege, default ACL, extra table privilege on our own table
  await bad("GRANT SELECT(owner_id) ON gymos.gym_entities TO gymos_refs_maint","REVOKE SELECT(owner_id) ON gymos.gym_entities FROM gymos_refs_maint",/column privileges|unrelated ownership, ACL/);
  await bad("GRANT UPDATE ON gymos.invoice_allocation_refs TO gymos_refs_maint","REVOKE UPDATE ON gymos.invoice_allocation_refs FROM gymos_refs_maint",/unintended table privileges/);
  await bad("GRANT SELECT ON gymos.invoice_allocation_refs TO gymos_refs_maint WITH GRANT OPTION","REVOKE GRANT OPTION FOR SELECT ON gymos.invoice_allocation_refs FROM gymos_refs_maint",/unintended table privileges/);
  await bad("GRANT CREATE ON SCHEMA gymos TO gymos_refs_maint","REVOKE CREATE ON SCHEMA gymos FROM gymos_refs_maint",/unintended schema privileges/);
  await bad("CREATE FUNCTION gymos.invoice_allocation_refs_sync(x int) RETURNS int LANGUAGE sql AS 'SELECT 1'; ALTER FUNCTION gymos.invoice_allocation_refs_sync(int) OWNER TO gymos_refs_maint","DROP FUNCTION gymos.invoice_allocation_refs_sync(int)",/unrelated ownership, ACL/);
  await bad("ALTER DEFAULT PRIVILEGES FOR ROLE gymos_refs_maint IN SCHEMA gymos GRANT SELECT ON TABLES TO gymos_app","ALTER DEFAULT PRIVILEGES FOR ROLE gymos_refs_maint IN SCHEMA gymos REVOKE SELECT ON TABLES FROM gymos_app",/default ACLs/);
  await bad("GRANT SELECT ON gymos.gym_entities TO gymos_refs_maint","REVOKE SELECT ON gymos.gym_entities FROM gymos_refs_maint",/unrelated ownership, ACL/);
  await bad("GRANT EXECUTE ON FUNCTION gymos.invoice_allocation_refs_complete(text,text) TO gymos_refs_maint","REVOKE EXECUTE ON FUNCTION gymos.invoice_allocation_refs_complete(text,text) FROM gymos_refs_maint",/unrelated ownership, ACL/);
  await c.query("SET ROLE postgres");await run();await c.query("RESET ROLE");
});
