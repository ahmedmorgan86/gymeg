// Native PostgreSQL test of the operational readiness workflow (scripts/refs-ready.mjs): needs REHEARSAL_DATABASE_URL (disposable DB, all migrations applied, superuser/migration role).
import pg from 'pg';import assert from 'node:assert/strict';
const {readyOwner,pendingOwners}=await import('../scripts/refs-ready.mjs');
const url=process.env.REHEARSAL_DATABASE_URL;const S=new pg.Client({connectionString:url});await S.connect();
const O='RDY1';
const q=(s,v)=>S.query(s,v);
const ready=async()=>(await q("SELECT ready FROM gymos.invoice_allocation_refs_state WHERE owner_id=$1",[O])).rows[0]?.ready;
const seed=async(n)=>{await q("DELETE FROM gymos.gym_entities WHERE owner_id=$1",[O]);await q("DELETE FROM gymos.gym_states WHERE user_id=$1",[O]);await q("DELETE FROM gymos.invoice_allocation_refs_state WHERE owner_id=$1",[O]);
  await q("INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,'{\"generation\":\"g0\"}',1,'x')",[O]);
  await q("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) SELECT $1,'invoices','i'||g,g,'a',jsonb_build_object('id','i'||g,'allocations',jsonb_build_array(jsonb_build_object('payment','p'||g,'minor',1))) FROM generate_series(1,$2::int) g",[O,n]);};
const locks=async()=>Number((await q("SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state IN ('idle in transaction','active') AND query ILIKE '%invoice_allocation_refs%'")).rows[0].n);
const free=async()=>{const c=new pg.Client({connectionString:url});await c.connect();try{await c.query("BEGIN");await c.query("SET LOCAL lock_timeout=500");await c.query("SELECT 1 FROM gymos.gym_states WHERE user_id=$1 FOR UPDATE NOWAIT",[O]);await c.query("ROLLBACK");return true;}catch{return false;}finally{await c.end();}};
const T={batch:10,lockMs:700,stmtMs:3000};
// 1) tombstoned owner with invoices becomes ready via the workflow, in several bounded batches, and pendingOwners sees it before and not after
await seed(55);await q("UPDATE gymos.gym_states SET payload='{\"generation\":\"g1\"}',revision=2 WHERE user_id=$1",[O]);assert.equal(await ready(),false);
assert.ok((await pendingOwners(url)).includes(O));
let r=await readyOwner(url,O,T);assert.equal(r.status,'ready',JSON.stringify(r));assert.ok(r.batches>=6);assert.equal(r.generation,'"g1"');assert.equal(await ready(),true);assert.ok(!(await pendingOwners(url)).includes(O));
// 2) bounded work + resume with the SAME captured generation; a changed generation refuses the token
await seed(55);await q("UPDATE gymos.gym_states SET payload='{\"generation\":\"g1\"}',revision=2 WHERE user_id=$1",[O]);
r=await readyOwner(url,O,{...T,maxBatches:2});assert.equal(r.status,'incomplete');assert.equal(await ready(),false);
const tok=r.resume;r=await readyOwner(url,O,{...T,resume:tok});assert.equal(r.status,'ready',JSON.stringify(r));
await q("UPDATE gymos.gym_states SET payload='{\"generation\":\"g2\"}',revision=3 WHERE user_id=$1",[O]);assert.equal(await ready(),false);
r=await readyOwner(url,O,{...T,resume:tok});assert.equal(r.status,'generation-changed');assert.equal(await ready(),false);
// 3) a restore between the final rebuild batch and completion: refuses, tombstone stays, no partial readiness
r=await readyOwner(url,O,{...T,hooks:{beforeComplete:async()=>{await q("UPDATE gymos.gym_states SET payload='{\"generation\":\"g3\"}',revision=4 WHERE user_id=$1",[O]);}}});
assert.equal(r.status,'generation-changed',JSON.stringify(r));assert.equal(await ready(),false);
// 4) actual lock timeout: another transaction holds the owner row; the workflow returns lock-timeout in ~lockMs, nothing left holding locks, owner row free afterwards
const H=new pg.Client({connectionString:url});await H.connect();await H.query("BEGIN");await H.query("SELECT 1 FROM gymos.gym_states WHERE user_id=$1 FOR UPDATE",[O]);
let t0=Date.now();r=await readyOwner(url,O,T);const el=Date.now()-t0;await H.query("ROLLBACK");await H.end();
assert.equal(r.status,'lock-timeout',JSON.stringify(r));assert.ok(el<2500,'returned in '+el+'ms');assert.equal(await ready(),false);assert.equal(await locks(),0);assert.ok(await free());
// 5) actual statement timeout on a really long-running completion: slow the scan (scratch DB only), run with a 1.5s statement bound
await seed(400);await q("UPDATE gymos.gym_states SET payload='{\"generation\":\"g1\"}',revision=2 WHERE user_id=$1",[O]);
const orig=(await q("SELECT pg_get_functiondef('gymos.invoice_allocation_ref_rows(text,text,integer,text,jsonb)'::regprocedure) d")).rows[0].d;
await q(`CREATE OR REPLACE FUNCTION gymos.invoice_allocation_ref_rows(p_owner text,p_invoice text,p_position integer,p_branch text,p_payload jsonb)
 RETURNS TABLE(owner_id text,invoice_id text,ord integer,payment_id text,payment_key text,has_minor boolean,minor jsonb,invoice_position integer,invoice_branch text) LANGUAGE plpgsql STABLE AS $$ BEGIN PERFORM pg_sleep(0.02);
 RETURN QUERY SELECT p_owner,p_invoice,(a.ord-1)::integer,a.v->>'payment',md5(a.v->>'payment'),(a.v ? 'minor'),a.v->'minor',p_position,p_branch FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_payload->'allocations')='array' THEN p_payload->'allocations' ELSE '[]'::jsonb END) WITH ORDINALITY a(v,ord) WHERE jsonb_typeof(a.v)='object' AND jsonb_typeof(a.v->'payment')='string'; END $$`);
try{
  t0=Date.now();r=await readyOwner(url,O,{...T,batch:1000,stmtMs:1500});const el2=Date.now()-t0;
  assert.ok(['statement-timeout','client-timeout'].includes(r.status),JSON.stringify(r));assert.ok(el2<6000,'bounded: '+el2+'ms');
  assert.equal(await ready(),false);assert.equal(await locks(),0,'no leftover backend');assert.ok(await free(),'completion SHARE lock released');
  console.log('long-running call stopped as',r.status,'after',el2,'ms');
}finally{await q(orig);}
// 6) after the slow function is restored the same owner can complete
r=await readyOwner(url,O,T);assert.equal(r.status,'ready',JSON.stringify(r));
// 7) a connection that stalls: unreachable server is bounded by connect timeout
t0=Date.now();r=await readyOwner('postgresql://postgres@127.0.0.1:1/x',O,{...T,connectMs:800});assert.ok(Date.now()-t0<3000);assert.ok(r.status==='client-timeout'||r.status==='error');
await q("DELETE FROM gymos.gym_entities WHERE owner_id=$1",[O]);await q("DELETE FROM gymos.gym_states WHERE user_id=$1",[O]);await q("DELETE FROM gymos.invoice_allocation_refs_state WHERE owner_id=$1",[O]);await S.end();
console.log('READY WORKFLOW PASS');
