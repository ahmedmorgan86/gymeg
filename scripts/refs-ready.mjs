// Operational readiness workflow for gymos.invoice_allocation_refs (held, local, migration-role only; run against a disposable/rehearsal database until reviewed).
// For one owner: capture the exact generation text BEFORE the first rebuild batch, rebuild in bounded batches (each its own transaction, transaction-local timeouts set by a separate completed command),
// then complete(owner, generation). Fail closed with a recoverable status; never commits partial readiness; on any timeout the transaction is rolled back and the connection is disposed, never reused.
// Numbers are JUDGMENT defaults, not derived: batch 500 invoices, 200 batches per call, lock 2s, statement 15s, connect 5s, idle-in-transaction 5s, absolute deadline 10 min.
// complete() holds the owner's gym_states row FOR SHARE until its transaction ends, so it is committed/rolled back immediately after it returns (true or false).
import pg from 'pg';
export const DEFAULTS={batch:500,maxBatches:200,lockMs:2000,stmtMs:15000,connectMs:5000,idleMs:5000,deadlineMs:600000};
const code=e=>e&&e.code;
class Timeout extends Error{constructor(w){super('client timeout: '+w);this.client=true;}}
const race=(p,ms,what,onTimeout)=>{let t;return Promise.race([p,new Promise((_,rej)=>{t=setTimeout(()=>{onTimeout?.();rej(new Timeout(what));},ms);})]).finally(()=>clearTimeout(t));};
export async function connect(url,o){const c=new pg.Client({connectionString:url,connectionTimeoutMillis:o.connectMs});await race(c.connect(),o.connectMs+500,'connect',()=>c.end().catch(()=>{}));c.on('error',()=>{});return c;}
const dispose=async c=>{try{c.connection?.stream?.destroy();}catch{}try{await Promise.race([c.end(),new Promise(r=>setTimeout(r,500))]);}catch{}};
// one transaction: BEGIN; SET LOCAL timeouts (separate completed commands); work; COMMIT. Any failure: ROLLBACK (bounded) and dispose the connection.
async function tx(url,o,work){
  const c=await connect(url,o);let killed=false;const kill=()=>{killed=true;try{c.connection?.stream?.destroy();}catch{}};
  try{
    await race(c.query('BEGIN'),o.stmtMs,'begin',kill);
    await race(c.query(`SET LOCAL lock_timeout=${Number(o.lockMs)}`),o.stmtMs,'set lock_timeout',kill);
    await race(c.query(`SET LOCAL statement_timeout=${Number(o.stmtMs)}`),o.stmtMs,'set statement_timeout',kill);
    await race(c.query(`SET LOCAL idle_in_transaction_session_timeout=${Number(o.idleMs)}`),o.stmtMs,'set idle timeout',kill); // server-side guard if this client dies holding the completion SHARE lock
    const out=await work(q=>race(c.query(q.text,q.values),o.stmtMs+2000,'query',kill));
    await race(c.query('COMMIT'),o.stmtMs,'commit',kill);
    return out;
  }catch(e){
    if(!killed)try{await race(c.query('ROLLBACK'),2000,'rollback',kill);}catch{}
    e.disposed=true;throw e;
  }finally{await dispose(c);}
}
const classify=e=>code(e)==='57014'?'statement-timeout':code(e)==='55P03'?'lock-timeout':e.client?'client-timeout':'error';
export async function readyOwner(url,owner,opts={}){
  const o={...DEFAULTS,...opts};const hooks=o.hooks||{};
  const t0=Date.now();const left=()=>{if(Date.now()-t0>o.deadlineMs)throw Object.assign(new Error('absolute deadline exceeded'),{client:true});};
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
    await hooks.beforeComplete?.();left();
    // 3) completion bound to the captured generation
    const ok=await tx(url,o,async q=>(await q({text:'SELECT gymos.invoice_allocation_refs_complete($1,$2) AS x',values:[owner,generation]})).rows[0].x);
    if(ok)return{status:'ready',owner,generation,batches:n};
    // classify why it refused (read-only, bounded)
    const why=await tx(url,o,async q=>{
      const g=(await q({text:"SELECT ((payload::jsonb)->'generation')::text AS g FROM gymos.gym_states WHERE user_id=$1",values:[owner]})).rows[0];
      if(!g)return'no-metadata';if(g.g!==generation)return'generation-changed';
      const m=Number((await q({text:'SELECT gymos.invoice_allocation_refs_mismatches($1) AS n',values:[owner]})).rows[0].n);return m>0?'mismatch':'refused';});
    return{status:why,owner,generation,batches:n,note:why==='generation-changed'?'a restore happened during the workflow; readiness stays off; restart':why==='mismatch'?'refs differ from invoices; rerun (rebuild repairs)':undefined};
  }catch(e){return{status:classify(e),owner,generation,cursor:after,code:code(e)||null,message:String(e.message).slice(0,200),note:'transaction rolled back and connection disposed; readiness unchanged; safe to retry'};}
}
// owners that need work: have invoices without a ready row, or are tombstoned. Bounded by `limit`.
export async function pendingOwners(url,limit=100,opts={}){
  const o={...DEFAULTS,...opts};
  return tx(url,o,async q=>(await q({text:`SELECT owner_id FROM (
      SELECT DISTINCT i.owner_id FROM gymos.gym_entities i WHERE i.collection='invoices' AND NOT EXISTS (SELECT 1 FROM gymos.invoice_allocation_refs_state s WHERE s.owner_id=i.owner_id AND s.ready)
      UNION SELECT owner_id FROM gymos.invoice_allocation_refs_state WHERE NOT ready) x ORDER BY owner_id LIMIT $1`,values:[limit]})).rows.map(r=>r.owner_id));
}
if(import.meta.url===`file://${process.argv[1]}`){
  const url=process.env.REHEARSAL_DATABASE_URL;if(!url){console.error('REHEARSAL_DATABASE_URL (disposable/rehearsal database, migration role) is required');process.exit(2);}
  const owners=process.argv.slice(2).length?process.argv.slice(2):await pendingOwners(url);
  const out=[];for(const ow of owners)out.push(await readyOwner(url,ow));
  console.log(JSON.stringify(out,null,1));process.exit(out.every(r=>r.status==='ready')?0:1);
}
