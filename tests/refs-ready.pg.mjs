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
// 5) real long-running COMPLETE: rebuild runs at full speed; the slow function is injected only AFTER rebuild (beforeComplete hook). Assert, from another connection, that the backend is executing complete() holding the owner SHARE lock BEFORE the timeout, then that it stops, releases, leaves no backend, and a retry succeeds.
await seed(400);await q("UPDATE gymos.gym_states SET payload='{\"generation\":\"g1\"}',revision=2 WHERE user_id=$1",[O]);
const orig=(await q("SELECT pg_get_functiondef('gymos.invoice_allocation_ref_rows(text,text,integer,text,jsonb)'::regprocedure) d")).rows[0].d;
const slow=async()=>q(`CREATE OR REPLACE FUNCTION gymos.invoice_allocation_ref_rows(p_owner text,p_invoice text,p_position integer,p_branch text,p_payload jsonb)
 RETURNS TABLE(owner_id text,invoice_id text,ord integer,payment_id text,payment_key text,has_minor boolean,minor jsonb,invoice_position integer,invoice_branch text) LANGUAGE plpgsql STABLE AS $$ BEGIN PERFORM pg_sleep(0.02);
 RETURN QUERY SELECT p_owner,p_invoice,(a.ord-1)::integer,a.v->>'payment',md5(a.v->>'payment'),(a.v ? 'minor'),a.v->'minor',p_position,p_branch FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_payload->'allocations')='array' THEN p_payload->'allocations' ELSE '[]'::jsonb END) WITH ORDINALITY a(v,ord) WHERE jsonb_typeof(a.v)='object' AND jsonb_typeof(a.v->'payment')='string'; END $$`);
const running=async()=>(await q("SELECT pid,state,wait_event FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND query ILIKE '%invoice_allocation_refs_complete%' AND query NOT ILIKE '%pg_stat_activity%'")).rows;
const rowShared=async()=>!(await free()); // FOR UPDATE NOWAIT fails while SHARE is held
let seen=null;
try{
  t0=Date.now();
  const pr=readyOwner(url,O,{...T,stmtMs:2500,lockMs:700,hooks:{beforeComplete:slow}});
  let tries=0;while(!seen&&tries++<60){await new Promise(r=>setTimeout(r,50));const rr=await running();if(rr.length&&await rowShared())seen=rr[0];}
  assert.ok(seen,'complete() was executing with the owner SHARE lock before the timeout');
  r=await pr;const el2=Date.now()-t0;
  assert.equal(r.status,'statement-timeout',JSON.stringify(r));assert.ok(el2<7000,'bounded: '+el2+'ms');
  assert.equal(await ready(),false);assert.equal((await running()).length,0,'no abandoned backend running complete');assert.equal(await locks(),0);assert.ok(await free(),'completion SHARE lock released');
  console.log('complete() observed executing with SHARE (pid',seen.pid,') ; stopped as',r.status,'after',el2,'ms');
  // absolute deadline: 100ms total must not enter a 15s query; returns promptly, nothing left
  t0=Date.now();r=await readyOwner(url,O,{...T,stmtMs:15000,deadlineMs:100,hooks:{beforeComplete:slow}});const el3=Date.now()-t0;
  assert.ok(el3<1500,'100ms deadline returned in '+el3+'ms');assert.ok(['client-timeout','statement-timeout','lock-timeout'].includes(r.status),JSON.stringify(r));console.log('100ms deadline ->',r.status,el3,'ms');assert.equal(await ready(),false);
  await new Promise(r=>setTimeout(r,300));assert.equal((await running()).length,0);assert.ok(await free());
  // deadline that expires DURING complete (rebuild done, ~600ms budget left): stops by the deadline, not by the 15s statement bound
  t0=Date.now();r=await readyOwner(url,O,{...T,stmtMs:15000,lockMs:700,deadlineMs:1500,hooks:{beforeComplete:slow}});const el4=Date.now()-t0;
  assert.ok(el4<3500,'deadline during complete: '+el4+'ms');assert.ok(['client-timeout','statement-timeout'].includes(r.status),JSON.stringify(r));
  await new Promise(r=>setTimeout(r,400));assert.equal((await running()).length,0);assert.ok(await free());assert.equal(await ready(),false);
}finally{await q(orig);}
// 6) after the slow function is restored the same owner can complete (retry)
r=await readyOwner(url,O,T);assert.equal(r.status,'ready',JSON.stringify(r));
// 7) controlled STALLED connection: a TCP server that accepts and never answers; a short total deadline bounds connect
import net from 'node:net';
const stall=net.createServer(sk=>{sk.on('error',()=>{});});await new Promise(r=>stall.listen(0,'127.0.0.1',r));
t0=Date.now();r=await readyOwner('postgresql://postgres@127.0.0.1:'+stall.address().port+'/x',O,{...T,connectMs:30000,deadlineMs:700});const el5=Date.now()-t0;
assert.equal(r.status,'client-timeout',JSON.stringify(r));assert.ok(el5<2000,'stalled connect bounded by total deadline: '+el5+'ms');stall.close();
// (refused connection is a different case: immediate error)
r=await readyOwner('postgresql://postgres@127.0.0.1:1/x',O,{...T,deadlineMs:800});assert.ok(['client-timeout','error'].includes(r.status));
await q("DELETE FROM gymos.gym_entities WHERE owner_id=$1",[O]);await q("DELETE FROM gymos.gym_states WHERE user_id=$1",[O]);await q("DELETE FROM gymos.invoice_allocation_refs_state WHERE owner_id=$1",[O]);await S.end();
console.log('READY WORKFLOW PASS');
