import {test} from 'node:test';import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const db=globalThis.__hotDb=await bootstrapDb();
registerHooks({
  resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}},
  load(url,ctx,next){if(url.endsWith('/app/lib/database.ts'))return{format:'module',shortCircuit:true,source:`export const getPool=()=>({connect:async()=>({query:(sql,v)=>globalThis.__hotDb.query(sql,v),release(){}})});export const withScope=async()=>{throw new Error('x')};`};return next(url,ctx);}
});
const {splitState}=await import('../app/lib/entity-state.ts');
const {fixture}=await import('./member-summary-fixture.mjs');
const {readAttendance}=await import('../app/lib/attendance-page.ts');
const scope=(o,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);return work(c);});
test('normal readAttendance rows statement carries the canonical predicate so the partial index is eligible',async()=>{
  const owner='ATTP';const s=fixture();s.visits=s.visits.filter(v=>v.leftAt);
  const {metadata,entities}=splitState(s);
  await db.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,5,$3)',[owner,JSON.stringify({...metadata,_entityStorage:1,_activityArchive:1}),'x']);
  for(const e of entities)await db.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',[owner,e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);
  const seen=[];const rec=(o,work)=>scope(o,c=>work({query:(q,v)=>{seen.push(q);return c.query(q,v);}}));
  const d=await readAttendance(rec,{owner,branch:s.visits[0]?.branch??'a',day:'2026-03-15'});
  assert.equal(d.status,'ok');
  const rows=seen.find(q=>/ORDER BY demand_visit_day DESC,visit_at DESC/.test(q));assert.ok(rows);
  assert.match(rows,/collection='visits' AND branch=\$2 AND collection='visits' AND NOT visit_odd/);
});

test('a writer making a row irregular between the probe and the rows read yields stale, never an omitting ok',async()=>{
  const owner='ATTW';const s=fixture();s.visits=s.visits.filter(v=>v.leftAt);
  const {metadata,entities}=splitState(s);
  await db.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,5,$3)',[owner,JSON.stringify({...metadata,_entityStorage:1,_activityArchive:1}),'x']);
  for(const e of entities)await db.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',[owner,e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);
  const v=s.visits[0];let fired=false;
  const rec=(o,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);return work({query:async(q,vals)=>{const r=await c.query(q,vals);
    if(!fired&&/SELECT EXISTS/.test(q)){fired=true;await c.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{at}','\"not a time\"') WHERE owner_id=$1 AND collection='visits' AND entity_id=$2",[owner,v.id]);}
    return r;}});});
  const d=await readAttendance(rec,{owner,branch:v.branch,day:'2026-03-15'});
  assert.notEqual(d.status,'ok','must not return ok that omits the newly irregular row');
  assert.ok(fired);
});
