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
// every case: restore the real function, reseed, rebuild at full speed; inject slow ONLY in beforeComplete; assert complete() active with SHARE before the stop, then release/no backend/retry
const reset=async()=>{await q(orig);await seed(400);await q("UPDATE gymos.gym_states SET payload='{\"generation\":\"g1\"}',revision=2 WHERE user_id=$1",[O]);};
const caseRun=async(label,opts,expect)=>{await reset();let seenC=null;const t=Date.now();
  const pr=readyOwner(url,O,{...T,...opts,hooks:{beforeComplete:slow}});
  for(let i=0;i<80&&!seenC;i++){await new Promise(r=>setTimeout(r,25));const rr=await running();if(rr.length&&await rowShared())seenC=rr[0];}
  const res=await pr;const el=Date.now()-t;
  assert.ok(seenC,label+': complete() active with owner SHARE before stop');assert.ok(expect.includes(res.status),label+' '+JSON.stringify(res));
  await new Promise(r=>setTimeout(r,300));
  assert.equal(await ready(),false);assert.equal((await running()).length,0,label+': no abandoned backend');assert.equal(await locks(),0);assert.ok(await free(),label+': SHARE released');
  await q(orig);const rt=await readyOwner(url,O,T);assert.equal(rt.status,'ready',label+' retry '+JSON.stringify(rt));
  console.log(label,'-> active complete pid',seenC.pid,'; stopped as',res.status,'after',el,'ms; released; retry ready');return el;};
try{
  let el=await caseRun('stmt-bound 2.5s',{stmtMs:2500},['statement-timeout']);assert.ok(el<7000);
  el=await caseRun('deadline 1500ms (15s stmt bound)',{stmtMs:15000,deadlineMs:1500},['client-timeout','statement-timeout']);assert.ok(el<4000,'el '+el);
}finally{await q(orig);}
// 100ms deadline cannot enter a 15s query: expires before any work starts or immediately after; measured, nothing left
{await reset();const t=Date.now();let tc=0;const res=await readyOwner(url,O,{...T,stmtMs:15000,deadlineMs:600000,hooks:{beforeComplete:async o=>{await slow();o.deadlineAt=Date.now()+100;tc=Date.now();}}});const e3=Date.now()-tc;await q(orig);
 assert.ok(e3<1500,'100ms remaining at complete -> '+e3);assert.ok(['client-timeout','statement-timeout','lock-timeout'].includes(res.status),JSON.stringify(res));console.log('rebuild done, 100ms left at complete(), 15s stmt bound ->',res.status,e3,'ms');
 await new Promise(r=>setTimeout(r,300));assert.equal((await running()).length,0);assert.ok(await free());assert.equal(await ready(),false);}
// expired deadline: zero connections attempted, no SQL, nothing changed
import net from 'node:net';
{let conns=0;const sv=net.createServer(sk=>{conns++;sk.on('error',()=>{});});await new Promise(r=>sv.listen(0,'127.0.0.1',r));
 const before=await ready();const res=await readyOwner('postgresql://postgres@127.0.0.1:'+sv.address().port+'/x',O,{...T,deadlineMs:0});
 assert.equal(res.status,'client-timeout',JSON.stringify(res));assert.equal(conns,0,'zero connects with an expired deadline');assert.equal(await ready(),before);sv.close();console.log('expired deadline -> 0 connects, status',res.status);}
// COMMIT acknowledgement lost: a proxy forwards the completion COMMIT then drops both sockets without relaying the reply
{await reset();let drop=false,dropped=0;
 const px=net.createServer(cl=>{let cut=false;const up=net.connect('/tmp/pgdata/.s.PGSQL.5432');cl.on('error',()=>{});up.on('error',()=>{});
  cl.on('data',d=>{if(drop&&d.toString('latin1').includes('COMMIT')){drop=false;cut=true;dropped++;up.write(d);setTimeout(()=>{cl.destroy();up.destroy();},150);return;}up.write(d);});up.on('data',d=>{if(!cut&&!cl.destroyed)cl.write(d);});cl.on('close',()=>up.destroy());up.on('close',()=>cl.destroy());});
 await new Promise(r=>px.listen(0,'127.0.0.1',r));const purl='postgresql://postgres@127.0.0.1:'+px.address().port+'/rehearsal_w';
 const res=await readyOwner(purl,O,{...T,hooks:{beforeComplete:async()=>{drop=true;}}});
 await new Promise(r=>setTimeout(r,500));if(process.env.DBG)console.error('LATE ready',await ready(),JSON.stringify(res));assert.equal(dropped,1);assert.equal(res.status,'outcome-unknown',JSON.stringify(res));assert.equal(res.reconcile.ready,true,'the server DID commit; reported only through reconcile');assert.equal(res.reconcile.generation,'"g1"');
 console.log('lost COMMIT ack -> outcome-unknown; reconcile',JSON.stringify(res.reconcile));px.close();}
// 6) after the slow function is restored the same owner can complete (retry)
r=await readyOwner(url,O,T);assert.equal(r.status,'ready',JSON.stringify(r));
// 7) controlled STALLED connection: a TCP server that accepts and never answers; a short total deadline bounds connect
const stall=net.createServer(sk=>{sk.on('error',()=>{});});await new Promise(r=>stall.listen(0,'127.0.0.1',r));
t0=Date.now();r=await readyOwner('postgresql://postgres@127.0.0.1:'+stall.address().port+'/x',O,{...T,connectMs:30000,deadlineMs:700});const el5=Date.now()-t0;
assert.equal(r.status,'client-timeout',JSON.stringify(r));assert.ok(el5<2000,'stalled connect bounded by total deadline: '+el5+'ms');stall.close();
// (refused connection is a different case: immediate error)
r=await readyOwner('postgresql://postgres@127.0.0.1:1/x',O,{...T,deadlineMs:800});assert.ok(['client-timeout','error'].includes(r.status));
// 8) trigger-bypass import sequence (EXCLUDED while readers are live; shown here only as the refusal/rebuild mechanics a trusted operator epoch would use): tombstone, bypass, complete refuses while stale, rebuild+complete
{const {invalidateOwner}=await import('../scripts/refs-ready.mjs');
 await seed(30);await q("UPDATE gymos.gym_states SET payload='{\"generation\":\"g1\"}',revision=2 WHERE user_id=$1",[O]);r=await readyOwner(url,O,T);assert.equal(r.status,'ready');assert.equal(await ready(),true);
 const inv=await invalidateOwner(url,O,T);assert.equal(inv.status,'invalidated');assert.equal(await ready(),false,'tombstone is in place before the import');
 for(const [t2,n] of [['gym_entities','invoice_allocation_refs_ins'],['gym_entities','invoice_allocation_refs_upd'],['gym_entities','invoice_allocation_refs_del']])await q(`ALTER TABLE gymos.${t2} DISABLE TRIGGER ${n}`);
 await q("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,'invoices','imp1',9001,'a','{\"id\":\"imp1\",\"allocations\":[{\"payment\":\"pz\",\"minor\":3}]}')",[O]);
 await q("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{allocations}','[]') WHERE owner_id=$1 AND entity_id='i1'",[O]);
 for(const [t2,n] of [['gym_entities','invoice_allocation_refs_ins'],['gym_entities','invoice_allocation_refs_upd'],['gym_entities','invoice_allocation_refs_del']])await q(`ALTER TABLE gymos.${t2} ENABLE TRIGGER ${n}`);
 const mm=Number((await q("SELECT gymos.invoice_allocation_refs_mismatches($1) n",[O])).rows[0].n);assert.ok(mm>0,'the bypass import left the refs stale: '+mm);
 assert.equal(await ready(),false,'still unready: no reader may use the stale refs');
 const cmp=await q("SELECT gymos.invoice_allocation_refs_complete($1,'\"g1\"') x",[O]);assert.equal(cmp.rows[0].x,false,'complete refuses while refs are stale');assert.equal(await ready(),false);
 r=await readyOwner(url,O,T);assert.equal(r.status,'ready',JSON.stringify(r));assert.equal(Number((await q("SELECT gymos.invoice_allocation_refs_mismatches($1) n",[O])).rows[0].n),0);assert.equal(await ready(),true);
 console.log('runbook: tombstone -> bypass import (stale mismatches '+mm+') -> complete refused -> rebuild+complete ready, mismatches 0');}
await q("DELETE FROM gymos.gym_entities WHERE owner_id=$1",[O]);await q("DELETE FROM gymos.gym_states WHERE user_id=$1",[O]);await q("DELETE FROM gymos.invoice_allocation_refs_state WHERE owner_id=$1",[O]);await S.end();
console.log('READY WORKFLOW PASS');
