// Real-PostgreSQL controlled interleavings of invoice_allocation_refs_complete/rebuild vs a persistSpace-style restore (owner gym_states FOR UPDATE first, entity diff, metadata generation UPDATE last).
// Needs REHEARSAL_DATABASE_URL (disposable DB with all migrations applied).
import pg from 'pg';import assert from 'node:assert/strict';
const mk=async()=>{const c=new pg.Client({connectionString:process.env.REHEARSAL_DATABASE_URL});await c.connect();return c;};
const A=await mk(),B=await mk(),S=await mk();
const O='RACE1';
const ready=async()=>(await S.query("SELECT ready FROM gymos.invoice_allocation_refs_state WHERE owner_id=$1",[O])).rows[0]?.ready;
const gen=async c=>(await c.query("SELECT ((payload::jsonb)->'generation')::text g FROM gymos.gym_states WHERE user_id=$1",[O])).rows[0].g;
const complete=(c,g)=>c.query("SELECT gymos.invoice_allocation_refs_complete($1,$2) x",[O,g]).then(r=>r.rows[0].x);
const reset=async()=>{await S.query("DELETE FROM gymos.gym_entities WHERE owner_id=$1",[O]);await S.query("DELETE FROM gymos.gym_states WHERE user_id=$1",[O]);await S.query("DELETE FROM gymos.invoice_allocation_refs_state WHERE owner_id=$1",[O]);
  await S.query("INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,'{}',1,'x')",[O]);
  await S.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,'invoices','i1',1,'a','{\"allocations\":[{\"payment\":\"p\"}]}')",[O]);};
const restore=async(c,g)=>{await c.query("SELECT 1 FROM gymos.gym_states WHERE user_id=$1 FOR UPDATE",[O]);await c.query("UPDATE gymos.gym_entities SET payload='{\"allocations\":[{\"payment\":\"p2\"}]}' WHERE owner_id=$1 AND entity_id='i1'",[O]);await c.query("UPDATE gymos.gym_states SET payload=$2,revision=revision+1 WHERE user_id=$1",[O,JSON.stringify({generation:g})]);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
await reset();
// 1) restore paused before commit; completion (expected = the OLD generation it read) waits on the owner row, then must refuse and leave the tombstone
await complete(S,await gen(S));assert.equal(await ready(),true);const g0=await gen(S);
await A.query("BEGIN");await restore(A,'g1');
await B.query("BEGIN");const p1=complete(B,g0);await sleep(300);
await A.query("COMMIT");assert.equal(await p1,false,'completion bound to the old generation must refuse');await B.query("COMMIT");
assert.equal(await ready(),false,'tombstone from the committed restore survives');
// 2) completion first (holds the share lock): a restore waits, commits after, tombstone wins
await complete(S,await gen(S));assert.equal(await ready(),true);
await B.query("BEGIN");assert.equal(await complete(B,await gen(B)),true);
await A.query("BEGIN");const p2=restore(A,'g2').then(()=>'done');await sleep(300);
await B.query("COMMIT");assert.equal(await p2,'done');await A.query("COMMIT");assert.equal(await ready(),false);
// 3) a restore between the final rebuild batch and completion: expected generation read before rebuild no longer matches
const gBefore=await gen(S);await S.query("SELECT gymos.invoice_allocation_refs_rebuild($1,NULL,100)",[O]);
await A.query("BEGIN");await restore(A,'g3');await A.query("COMMIT");
assert.equal(await complete(S,gBefore),false);assert.equal(await ready(),false);
assert.equal(await complete(S,await gen(S)),true,'completion bound to the current generation after rebuild succeeds');
// 4) snapshot-fixed isolation refused
await B.query("BEGIN ISOLATION LEVEL REPEATABLE READ");await assert.rejects(()=>complete(B,'x'),/READ COMMITTED/);await B.query("ROLLBACK");
// 5) deadlock/ordering stress: concurrent restore, rebuild and completion loops (same lock order), then invariants
const C=await mk();const errs=[];const note=e=>{errs.push(e.code+':'+e.message);};
for(let i=0;i<40;i++){
  await Promise.all([
    (async()=>{try{await A.query("BEGIN");await restore(A,'s'+i);await A.query("COMMIT");}catch(e){note(e);await A.query("ROLLBACK").catch(()=>{});}})(),
    (async()=>{try{const g=await gen(B);await B.query("SELECT gymos.invoice_allocation_refs_rebuild($1,NULL,100)",[O]);await complete(B,g);}catch(e){note(e);}})(),
    (async()=>{try{const g=await gen(C);await complete(C,g);}catch(e){note(e);}})(),
  ]);
  // invariant: if ready, the refs are exact AND the generation equals the one just committed by the last restore or a later complete
  const r=await ready();const mm=Number((await S.query("SELECT gymos.invoice_allocation_refs_mismatches($1) n",[O])).rows[0].n);
  assert.equal(mm,0,'refs stay exact (triggers) at iteration '+i);
}
assert.deepEqual(errs.filter(e=>/^40P01|^55P03/.test(e)),[],'no deadlocks or lock failures: '+errs.slice(0,3).join(' | '));
await reset();await S.query("DELETE FROM gymos.gym_entities WHERE owner_id=$1",[O]);await S.query("DELETE FROM gymos.gym_states WHERE user_id=$1",[O]);await S.query("DELETE FROM gymos.invoice_allocation_refs_state WHERE owner_id=$1",[O]);
for(const c of [A,B,C,S])await c.end();console.log('RACE PASS');
