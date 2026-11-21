// Operational readiness workflow for gymos.invoice_allocation_refs (held, local, migration-role only; run against a disposable/rehearsal database until reviewed).
// For one owner: capture the exact generation text BEFORE the first rebuild batch, rebuild in bounded batches (each its own transaction, transaction-local timeouts set by a separate completed command),
// then complete(owner, generation). Fail closed with a recoverable status; never commits partial readiness; on any timeout the transaction is rolled back and the connection is disposed, never reused.
// Numbers are JUDGMENT defaults, not derived: batch 500 invoices, 200 batches per call, lock 2s, statement 15s, connect 5s, idle-in-transaction 5s, absolute deadline 10 min.
// complete() holds the owner's gym_states row FOR SHARE until its transaction ends, so it is committed/rolled back immediately after it returns (true or false).
import pg from 'pg';
export const DEFAULTS={batch:500,maxBatches:200,lockMs:2000,stmtMs:15000,connectMs:5000,idleMs:5000,deadlineMs:600000};
const code=e=>e&&e.code;
class Timeout extends Error{constructor(w){super('client timeout: '+w);this.client=true;}}
// ONE absolute deadline (o.deadlineAt, epoch ms) caps EVERY awaited phase: each phase gets min(its own budget, time remaining); no remaining time fails before starting the phase.
const rem=o=>o.deadlineAt-Date.now();
const race=(o,thunk,ms,what,onTimeout)=>{const r=rem(o);if(r<=0)return Promise.reject(new Timeout(what+' (deadline, not started)'));  // nothing is invoked (no connect/SQL/hook) once the deadline has passed
  let t;let p;try{p=Promise.resolve(thunk());}catch(e){return Promise.reject(e);}p.catch(()=>{});
  return Promise.race([p,new Promise((_,rej)=>{t=setTimeout(()=>{onTimeout?.();rej(new Timeout(what));},Math.max(1,Math.min(ms,r)));})]).finally(()=>clearTimeout(t));};
export async function connect(url,o){if(o.deadlineAt==null)o={...o,deadlineAt:Date.now()+o.deadlineMs};
  const c=new pg.Client({connectionString:url,connectionTimeoutMillis:Math.max(1,Math.min(o.connectMs,rem(o)))});c.on('error',()=>{});
  const kill=()=>{try{c.connection?.stream?.destroy();}catch{}};
  await race(o,()=>c.connect(),o.connectMs,'connect',kill);return c;}
const dispose=async c=>{try{c.connection?.stream?.destroy();}catch{}};  // destroying the socket ends the backend; never waits on the server
// one transaction: BEGIN; SET LOCAL timeouts (separate completed commands, server bounds also capped by the remaining deadline); work; COMMIT. Any failure: connection destroyed (server rolls back the open transaction) after a bounded ROLLBACK attempt.
async function tx(url,o,work){
  const c=await connect(url,o);let killed=false;const kill=()=>{killed=true;try{c.connection?.stream?.destroy();}catch{}};
  try{
    const sv=()=>Math.max(1,Math.min(Number(o.stmtMs),rem(o)));
    await race(o,()=>c.query('BEGIN'),o.stmtMs,'begin',kill);
    await race(o,()=>c.query(`SET LOCAL lock_timeout=${Math.max(1,Math.min(Number(o.lockMs),rem(o)))}`),o.stmtMs,'set lock_timeout',kill);
    await race(o,()=>c.query(`SET LOCAL statement_timeout=${sv()}`),o.stmtMs,'set statement_timeout',kill);
    await race(o,()=>c.query(`SET LOCAL idle_in_transaction_session_timeout=${Number(o.idleMs)}`),o.stmtMs,'set idle timeout',kill); // server-side guard if this client dies holding the completion SHARE lock
    const out=await work(q=>race(o,()=>c.query(q.text,q.values),o.stmtMs+2000,'query',kill));
    try{await race(o,()=>c.query('COMMIT'),o.stmtMs,'commit',kill);}catch(e){e.commitUnknown=true;throw e;}  // acknowledgement lost or timed out: the server may or may not have committed
    return out;
  }catch(e){
    if(!killed&&!e.commitUnknown&&rem(o)>0)try{await race(o,()=>c.query('ROLLBACK'),Math.min(2000,Math.max(1,rem(o))),'rollback',kill);}catch{}
    e.disposed=true;throw e;
  }finally{await dispose(c);}
}
const classify=e=>code(e)==='57014'?'statement-timeout':code(e)==='55P03'?'lock-timeout':(e.client||/timeout expired|connection timeout/i.test(String(e.message)))?'client-timeout':'error';
// fresh, separately bounded read of (ready, generation) after a COMMIT whose outcome is unknown
async function reconcile(url,owner,o){const r={...o,deadlineAt:Date.now()+(o.reconcileMs??3000)};try{return await tx(url,r,async q=>{const a=(await q({text:'SELECT ready FROM gymos.invoice_allocation_refs_state WHERE owner_id=$1',values:[owner]})).rows[0];const g=(await q({text:"SELECT ((payload::jsonb)->'generation')::text AS g FROM gymos.gym_states WHERE user_id=$1",values:[owner]})).rows[0];return{ready:a?a.ready:null,generation:g?g.g:null};});}catch(e){return{unavailable:true,message:String(e.message).slice(0,120)};}}
export async function readyOwner(url,owner,opts={}){
  const o={...DEFAULTS,...opts};const hooks=o.hooks||{};o.deadlineAt=Date.now()+o.deadlineMs;
  const left=()=>{if(rem(o)<=0)throw new Timeout('absolute deadline');};
  let generation=o.resume?.generation,after=o.resume?.cursor??null;
  try{
    // 1) exact generation text, captured once, before the first rebuild batch (never resampled)
    const cur=await tx(url,o,async q=>{const r=await q({text:"SELECT true AS have,((payload::jsonb)->'generation')::text AS g FROM gymos.gym_states WHERE user_id=$1",values:[owner]});return r.rows[0]||null;}).catch(e=>{if(String(code(e)||'').startsWith('22'))return 'bad';throw e;});
    if(cur==='bad')return{status:'unparseable-metadata',owner};
    if(!cur)return{status:'no-metadata',owner};
    if(o.resume){if(cur.g!==generation)return{status:'generation-changed',owner,note:'resume token is for an older generation; restart without a token'};}
    else{generation=cur.g;after=null;}
    // 2) bounded rebuild batches
    let n=0;
    for(;;){
      left();if(n>=o.maxBatches)return{status:'incomplete',owner,resume:{generation,cursor:after},batches:n};
      const next=await tx(url,o,async q=>(await q({text:"SELECT gymos.invoice_allocation_refs_rebuild($1,$2,$3) AS a",values:[owner,after,o.batch]})).rows[0].a);
      n++;if(next===null)break;after=next;
    }
    await race(o,()=>hooks.beforeComplete?.(o),o.deadlineMs,'hook');left();
    // 3) completion bound to the captured generation
    const ok=await tx(url,o,async q=>(await q({text:'SELECT gymos.invoice_allocation_refs_complete($1,$2) AS x',values:[owner,generation]})).rows[0].x);
    if(ok)return{status:'ready',owner,generation,batches:n};
    // classify why it refused (read-only, bounded)
    const why=await tx(url,o,async q=>{
      const g=(await q({text:"SELECT ((payload::jsonb)->'generation')::text AS g FROM gymos.gym_states WHERE user_id=$1",values:[owner]})).rows[0];
      if(!g)return'no-metadata';if(g.g!==generation)return'generation-changed';
      const m=Number((await q({text:'SELECT gymos.invoice_allocation_refs_mismatches($1) AS n',values:[owner]})).rows[0].n);return m>0?'mismatch':'refused';});
    return{status:why,owner,generation,batches:n,note:why==='generation-changed'?'a restore happened during the workflow; readiness stays off; restart':why==='mismatch'?'refs differ from invoices; rerun (rebuild repairs)':undefined};
  }catch(e){if(e.commitUnknown){const rec=await reconcile(url,owner,o);return{status:'outcome-unknown',owner,generation,cursor:after,reconcile:rec,note:'COMMIT was not acknowledged: the transaction may have committed. Do not claim readiness or assume unchanged. Reconcile (ready flag and generation above, read fresh) before any retry.'};}
    return{status:classify(e),owner,generation,cursor:after,code:code(e)||null,message:String(e.message).slice(0,200),note:'transaction rolled back and connection disposed; readiness unchanged; safe to retry'};}
}
// Writes the tombstone for an owner so refs readers refuse from then on. This is NOT enough for a trigger-bypass/replica import (excluded while readers are live: the version triggers are origin-only too); see docs/refs-restore-runbook.md.
// One transaction per owner, bounded like every other phase.
export async function invalidateOwner(url,owner,opts={}){const o={...DEFAULTS,...opts};o.deadlineAt=Date.now()+o.deadlineMs;
  try{await tx(url,o,async q=>{await q({text:'INSERT INTO gymos.invoice_allocation_refs_state(owner_id,ready) VALUES($1,false) ON CONFLICT(owner_id) DO UPDATE SET ready=false,set_at=now()',values:[owner]});});return{status:'invalidated',owner};}
  catch(e){return{status:classify(e),owner,message:String(e.message).slice(0,200),note:'tombstone NOT confirmed'};}}
// owners that need work: have invoices without a ready row, or are tombstoned. Bounded by `limit`.
export async function pendingOwners(url,limit=100,opts={}){
  const o={...DEFAULTS,...opts};o.deadlineAt=Date.now()+o.deadlineMs;
  return tx(url,o,async q=>(await q({text:`SELECT owner_id FROM (
      SELECT DISTINCT i.owner_id FROM gymos.gym_entities i WHERE i.collection='invoices' AND NOT EXISTS (SELECT 1 FROM gymos.invoice_allocation_refs_state s WHERE s.owner_id=i.owner_id AND s.ready)
      UNION SELECT owner_id FROM gymos.invoice_allocation_refs_state WHERE NOT ready) x ORDER BY owner_id LIMIT $1`,values:[limit]})).rows.map(r=>r.owner_id));
}
if(import.meta.url===`file://${process.argv[1]}`){
  const url=process.env.REHEARSAL_DATABASE_URL;if(!url){console.error('REHEARSAL_DATABASE_URL (disposable/rehearsal database, migration role) is required');process.exit(2);}
  if(process.argv[2]==='--invalidate'){const r=[];for(const ow of process.argv.slice(3))r.push(await invalidateOwner(url,ow));console.log(JSON.stringify(r,null,1));process.exit(r.every(x=>x.status==='invalidated')?0:1);}
  const owners=process.argv.slice(2).length?process.argv.slice(2):await pendingOwners(url);
  const out=[];for(const ow of owners)out.push(await readyOwner(url,ow));
  console.log(JSON.stringify(out,null,1));process.exit(out.every(r=>r.status==='ready')?0:1);
}
