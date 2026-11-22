import {test} from 'node:test';import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const db=globalThis.__hotDb=await bootstrapDb();
registerHooks({
  resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}},
  load(url,ctx,next){if(url.endsWith('/app/lib/database.ts'))return{format:'module',shortCircuit:true,source:`export const getPool=()=>({connect:async()=>({query:(sql,v)=>globalThis.__hotDb.query(sql,v),release(){}})});export const isFirebaseConfigured=()=>false;`};return next(url,ctx);}
});
const {persistSpace}=await import('../app/lib/entity-store.ts');
const {splitState}=await import('../app/lib/entity-state.ts');
const {fixture}=await import('./member-summary-fixture.mjs');
const {readVisitTrend}=await import('../app/lib/visit-trend-page.ts');
const {deriveTrend}=await import('../app/lib/visit-trend-derive.ts');
const {addDays}=await import('../app/lib/domain.ts');
const {chooseVisitTrend}=await import('../app/use-visit-trend.ts');
const scope=(o,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);return work(c);});
let sd=11;const rnd=()=>{sd=(sd*1664525+1013904223)>>>0;return sd/2**32;};const pick=a=>a[Math.floor(rnd()*a.length)];
const iso=(d,h)=>d+'T'+String(h).padStart(2,'0')+':00:00.000Z';
async function seed(owner,s){
  const {metadata,entities}=splitState(s);
  await db.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,5,$3)',[owner,JSON.stringify({...metadata,_entityStorage:1,_activityArchive:1}),'x']);
  for(const e of entities)await db.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',[owner,e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);
}
test('visit trend numbers == the legacy packet expressions (range edges, future days, ties); odd data fails closed',async()=>{
  const s=fixture();s.visits=[];s.payments=[];s.invoices=[];s.branches.push({id:'c',name:'C'});
  const days=[];for(let i=-40;i<=3;i++)days.push(addDays('2026-03-14',i));
  let n=0;for(let k=0;k<1500;k++){const m=pick(s.members),d=pick(days);s.visits.push({id:'v'+n++,member:m.id,branch:pick(['a','b','c']),day:d,at:iso(d,k%24),leftAt:iso(d,k%24),method:'x'});}
  await seed('T1',s);
  for(const branch of ['a','b','c'])for(const today of ['2026-03-14','2026-03-01','2026-02-20','2027-01-01'])for(const period of [1,7,14]){
    const visits=s.visits.filter(v=>v.branch===branch);
    const weekVisits=visits.filter(v=>v.day>=addDays(today,1-period)&&v.day<=today).length,prevWeek=visits.filter(v=>v.day>=addDays(today,1-period*2)&&v.day<addDays(today,1-period)).length;
    const values=Array.from({length:period},(_,i)=>{const day=addDays(today,i-period+1);return visits.filter(v=>v.day===day).length;});
    const r=await readVisitTrend(scope,{owner:'T1',branch,today,period});assert.equal(r.status,'ok');
    assert.deepEqual(deriveTrend(r.days,today,period),{values,weekVisits,prevWeek,todayVisits:visits.filter(v=>v.day===today).length},branch+today+period);
    assert.ok(Object.values(r.days).every(x=>x>0)&&Object.keys(r.days).every(d=>d>=r.from&&d<=r.to));
  }
  const b=s.visits.find(v=>v.id==='v1').branch;
  for(const bad of ['"2026-3-9"','5','null']){
    await db.query(`UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{day}',$1::jsonb) WHERE owner_id='T1' AND entity_id='v1'`,[bad]);
    assert.deepEqual(await readVisitTrend(scope,{owner:'T1',branch:b,today:'2026-03-14',period:7}),{status:'unavailable',reason:'non-canonical-visit'},bad);
  }
  const other=['a','b','c'].find(x=>x!==b);assert.equal((await readVisitTrend(scope,{owner:'T1',branch:other,today:'2026-03-14',period:7})).status,'ok');
  await assert.rejects(readVisitTrend(scope,{owner:'T1',branch:'a',today:'x',period:7}),RangeError);
  await assert.rejects(readVisitTrend(scope,{owner:'T1',branch:'a',today:'2026-03-14',period:0}),RangeError);
  await assert.rejects(readVisitTrend(scope,{owner:'T1',branch:'a',today:'2026-03-14',period:3661}),RangeError);
});
test('client only uses days fetched for this state, owner, branch, day and period',()=>{
  const st={},got={owner:'o',branch:'a',today:'d',period:7,forState:st,days:{x:1}};
  assert.deepEqual(chooseVisitTrend(true,got,st,'o','a','d',7),{x:1});
  for(const a of [[false,got,st,'o','a','d',7],[true,got,{},'o','a','d',7],[true,got,st,'p','a','d',7],[true,got,st,'o','b','d',7],[true,got,st,'o','a','e',7],[true,got,st,'o','a','d',14],[true,null,st,'o','a','d',7]])assert.equal(chooseVisitTrend(...a),null);
});
