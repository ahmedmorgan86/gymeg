import pg from 'pg';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const c=new pg.Client({connectionString:'postgresql://postgres@localhost:55434/rehearsal_roles'});await c.connect();const q=(s,v)=>c.query(s,v);
const check=async()=>{
 const edges=(await q("SELECT pg_get_userbyid(member) member,pg_get_userbyid(grantor) grantor,admin_option,inherit_option,set_option FROM pg_auth_members WHERE roleid='gymos_refs_maint'::regrole OR member='gymos_refs_maint'::regrole")).rows;
 assert.deepEqual(edges,[{member:'postgres',grantor:'supabase_admin',admin_option:true,inherit_option:false,set_option:false}]);
 assert.deepEqual((await q("SELECT pg_has_role('postgres','gymos_refs_maint','SET') can_set,pg_has_role('postgres','gymos_refs_maint','USAGE') inherits,has_schema_privilege('gymos_refs_maint','gymos','CREATE') can_create,pg_has_role('gymos_app','gymos_refs_maint','MEMBER') runtime_member")).rows[0],{can_set:false,inherits:false,can_create:false,runtime_member:false});
 const funcs=(await q("SELECT proname,prosecdef,proconfig FROM pg_proc WHERE proowner='gymos_refs_maint'::regrole ORDER BY proname")).rows;
 assert.equal(funcs.length,4);for(const f of funcs){assert.equal(f.prosecdef,true);assert.deepEqual(f.proconfig,['search_path=pg_catalog, pg_temp']);}
 for(const t of ['invoice_allocation_refs','invoice_allocation_odd','invoice_allocation_refs_state']){
  assert.deepEqual((await q("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass",['gymos.'+t])).rows[0],{relrowsecurity:true,relforcerowsecurity:true});
  for(const p of ['INSERT','UPDATE','DELETE','TRUNCATE','TRIGGER'])assert.equal((await q('SELECT has_table_privilege($1,$2,$3) x',['gymos_app','gymos.'+t,p])).rows[0].x,false);
 }
 console.log('PASS exact residual provider membership, four pinned definer owners, FORCE RLS, runtime no membership/writes, no temporary SET/CREATE');
};await check();
const sql=readFileSync(new URL('../supabase/migrations/20261122030000_invoice_allocation_refs.sql',import.meta.url),'utf8');const block=sql.slice(sql.indexOf('DO $ownership$'));
const broken=block.replace('ALTER FUNCTION gymos.invoice_allocation_refs_truncate() OWNER TO gymos_refs_maint;',"RAISE EXCEPTION 'injected transfer failure';");
await assert.rejects(()=>q(broken),/injected transfer failure/);await check();console.log('PASS injected ownership-transfer failure rolls back temporary grants atomically');
await c.end();
