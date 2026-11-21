// Two-connection controlled interleaving of invoice_allocation_refs_complete vs a restore-style gym_states update, on a real PostgreSQL (needs REHEARSAL_DATABASE_URL with all migrations applied; disposable DB only).
import pg from 'pg';import assert from 'node:assert/strict';
const mk=async()=>{const c=new pg.Client({connectionString:process.env.REHEARSAL_DATABASE_URL});await c.connect();return c;};
const A=await mk(),B=await mk(),S=await mk();
const O='RACE1';
const ready=async()=>(await S.query("SELECT ready FROM gymos.invoice_allocation_refs_state WHERE owner_id=$1",[O])).rows[0]?.ready;
await S.query("DELETE FROM gymos.gym_entities WHERE owner_id=$1",[O]);await S.query("DELETE FROM gymos.gym_states WHERE user_id=$1",[O]);await S.query("DELETE FROM gymos.invoice_allocation_refs_state WHERE owner_id=$1",[O]);
await S.query("INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,'{}',1,'x')",[O]);
await S.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,'invoices','i1',1,'a','{\"allocations\":[{\"payment\":\"p\"}]}')",[O]);
const restore=(c,g)=>c.query("UPDATE gymos.gym_states SET payload=$2,revision=revision+1 WHERE user_id=$1",[O,JSON.stringify({generation:g})]);
// 1) completion holds its lock; a restore started meanwhile must wait; after both commit the tombstone wins
await B.query("BEGIN");await B.query("SELECT gymos.invoice_allocation_refs_complete($1)",[O]);
await A.query("BEGIN");await A.query("SET LOCAL lock_timeout='400ms'");
await assert.rejects(()=>restore(A,'g1'),/lock timeout|canceling statement/i);await A.query("ROLLBACK");
await A.query("BEGIN");const pending=restore(A,'g1').then(()=>'done');
await new Promise(r=>setTimeout(r,300));assert.equal(await ready(),undefined,'completion uncommitted: nothing visible yet');
await B.query("COMMIT");assert.equal(await pending,'done');await A.query("COMMIT");
assert.equal(await ready(),false,'restore committed after completion: tombstone must win');
// 2) restore holds the owner row; completion must wait, then (post-restore, refs exact) may mark ready
await A.query("BEGIN");await restore(A,'g2');
await B.query("BEGIN");await B.query("SET LOCAL lock_timeout='400ms'");
await assert.rejects(()=>B.query("SELECT gymos.invoice_allocation_refs_complete($1)",[O]),/lock timeout|canceling statement/i);await B.query("ROLLBACK");
await A.query("COMMIT");assert.equal(await ready(),false);
assert.equal((await S.query("SELECT gymos.invoice_allocation_refs_complete($1) x",[O])).rows[0].x,true);assert.equal(await ready(),true);
// 3) snapshot-fixed isolation is refused
await B.query("BEGIN ISOLATION LEVEL REPEATABLE READ");await assert.rejects(()=>B.query("SELECT gymos.invoice_allocation_refs_complete($1)",[O]),/READ COMMITTED/);await B.query("ROLLBACK");
await S.query("DELETE FROM gymos.gym_entities WHERE owner_id=$1",[O]);await S.query("DELETE FROM gymos.gym_states WHERE user_id=$1",[O]);await S.query("DELETE FROM gymos.invoice_allocation_refs_state WHERE owner_id=$1",[O]);
for(const c of [A,B,S])await c.end();console.log('RACE PASS 3/3');
