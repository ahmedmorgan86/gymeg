import {test} from 'node:test';import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {registerHooks} from 'node:module';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const db=globalThis.__hotDb=await bootstrapDb();
registerHooks({
  resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}},
  load(url,ctx,next){if(url.endsWith('/app/lib/database.ts'))return{format:'module',shortCircuit:true,source:`export const getPool=()=>({connect:async()=>({query:(sql,v)=>globalThis.__hotDb.query(sql,v),release(){}})});export const withScope=async()=>{throw new Error('x')};`};return next(url,ctx);}
});
const scope=(o,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);return work(c);});
test('arbitrary-length member keys never block a write; readers still find exactly their rows',async()=>{
  const owner='BIGM';const big=randomBytes(30000).toString('hex'),other=big.slice(0,-1)+'0'===big?big+'z':big.slice(0,-1)+(big.endsWith('0')?'1':'0');
  await db.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,5,$3)',[owner,JSON.stringify({_entityStorage:1,_activityArchive:1}),'x']);
  const ins=(c,id,pos,branch,pl)=>db.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',[owner,c,id,pos,branch,JSON.stringify(pl)]).catch(e=>{e.message+=' @'+c+id;throw e;});
  await ins('visits','v1',0,'a',{id:'v1',member:big,branch:'a',day:'2026-03-15',at:'2026-03-15T08:00:00.000Z',leftAt:'2026-03-15T09:00:00.000Z'});
  await ins('payments','p1',0,'a',{id:'p1',member:big,branch:'a',minor:5,day:'2026-03-15',method:'cash',voided:false});
  await ins('invoices','i1',0,'a',{id:'i1',member:big,branch:'a',total:10,due:'2026-03-15',voided:false,allocations:[]});
  await ins('invoices','i2',1,'a',{id:'i2',member:other,branch:'a',total:7,due:'2026-03-15',voided:false,allocations:[]});
  // the oversized key took the owner out of readiness: no summary row, no queue entry for it, and readers use the exact legacy paths
  assert.equal((await db.query("SELECT 1 FROM gymos.gym_member_summary_ready WHERE owner_id=$1",[owner])).rowCount,0);
  const {branchDuesTotal}=await import('../app/lib/member-summary-store.ts');
  assert.equal(await scope(owner,c=>branchDuesTotal(c,owner,'a')),null);
  const {readDues}=await import('../app/lib/dues-page.ts');
  const d=await readDues(scope,{owner,branch:'a'});assert.equal(d.status,'ok');assert.equal(d.total,17,'exact scan total over the long-key invoices');
  assert.deepEqual(d.rows.map(r=>r.invoice.id).sort(),['i1','i2']);
  // backfill refuses readiness while an oversized key exists
  await db.query("SELECT gymos.backfill_member_summaries($1)",[owner]);
  assert.equal((await db.query("SELECT 1 FROM gymos.gym_member_summary_ready WHERE owner_id=$1",[owner])).rowCount,0);
  const {readMemberDetail}=await import('../app/lib/member-detail-source.ts');void readMemberDetail;
});
