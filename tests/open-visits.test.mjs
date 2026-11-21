import {test} from 'node:test';import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const db=globalThis.__hotDb=await bootstrapDb();
registerHooks({
  resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}},
  load(url,ctx,next){if(url.endsWith('/app/lib/database.ts'))return{format:'module',shortCircuit:true,source:`export const getPool=()=>({connect:async()=>({query:(sql,v)=>globalThis.__hotDb.query(sql,v),release(){}})});export const isFirebaseConfigured=()=>false;`};return next(url,ctx);}
});
const {persistSpace}=await import('../app/lib/entity-store.ts');
const {refreshDirtySummaries,readMemberCandidates,REFRESH_MAX,MEMBER_CANDIDATE_MAX}=await import('../app/lib/member-summary-store.ts');
const {deriveSummary}=await import('../app/lib/member-summary-model.ts');
const {memberSummary}=await import('../app/lib/member-console.ts');
const {splitState}=await import('../app/lib/entity-state.ts');
const {fixture}=await import('./member-summary-fixture.mjs');
const localOf=(s,m)=>({...s,members:[m],visits:s.visits.filter(v=>v.member===m.id&&v.branch===m.branch),payments:s.payments.filter(p=>p.member===m.id&&p.branch===m.branch),invoices:(s.invoices??[]).filter(i=>i.member===m.id&&i.branch===m.branch)});
const ORACLE=(s,m,now)=>memberSummary(localOf(s,m),m,now); // what consoleIndex(branch) computes for a member of that branch
const strip=x=>JSON.parse(JSON.stringify(x));
async function seed(owner,state){
  state=structuredClone(state);const op=state.visits.filter(v=>v.member==='plain'&&!v.leftAt);for(const v of op.slice(1))v.leftAt=v.day+'T23:00:00.000Z'; // one open visit per member
  const {metadata,entities}=splitState(state);
  await db.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,5,$3)',[owner,JSON.stringify({...metadata,_entityStorage:1,_activityArchive:1}),'x']);
  for(const e of entities)await db.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',[owner,e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);
}
async function current(owner){const r=await db.query("SELECT collection,payload FROM gymos.gym_entities WHERE owner_id=$1 ORDER BY position,entity_id",[owner]);const s=fixture();const by=c=>r.rows.filter(x=>x.collection===c).map(x=>x.payload);s.members=by('members');s.visits=by('visits');s.payments=by('payments');s.invoices=by('invoices');return s;}
const {readOpenVisits}=await import('../app/lib/open-visits-page.ts');
const {checkinProfile,checkinProfileFromOpen}=await import('../app/lib/checkin-profile.ts');
const scope=(o,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);return work(c);});
let sd=11;const rnd=()=>{sd=(sd*1664525+1013904223)>>>0;return sd/2**32;};const pick=a=>a[Math.floor(rnd()*a.length)];
test('open visits == legacy !leftAt filter; popup selection == checkinProfile over consecutive states; falsy leftAt fails closed',async()=>{
  const NOW=Date.parse('2026-03-14T12:00:00.000Z');
  const s=fixture();s.visits=[];s.payments=[];s.invoices=[];s.generation='v1';
  const open=new Set();let n=0;
  for(const m of s.members){const b=m.branch;for(let k=0;k<5;k++){const isOpen=k===0&&rnd()<.5,at=new Date(NOW-Math.floor(rnd()*400000)).toISOString();s.visits.push({id:'v'+n++,member:m.id,branch:b,day:at.slice(0,10),at,...(rnd()<.3?{activeAt:new Date(NOW-Math.floor(rnd()*300000)).toISOString()}:{}),...(isOpen?{}:{leftAt:at})});}}
  await seed('O1',s);const cur=await current('O1');
  for(const branch of [...new Set(cur.members.map(m=>m.branch))]){
    const r=await readOpenVisits(scope,{owner:'O1',branch});assert.equal(r.status,'ok');
    const legacy=cur.visits.filter(v=>v.branch===branch&&!v.leftAt);
    assert.deepEqual(r.open.map(v=>v.id),legacy.map(v=>v.id));
    // consecutive states: next = previous with new activity on some open visits
    const prev=structuredClone(cur),next=structuredClone(cur);
    for(const v of next.visits.filter(v=>v.branch===branch&&!v.leftAt)){if(rnd()<.5)v.activeAt=new Date(NOW-Math.floor(rnd()*100000)).toISOString();}
    const members=new Set(next.members.filter(m=>m.branch===branch&&!m.archived).map(m=>m.id));
    const before=new Map(prev.visits.filter(v=>v.branch===branch&&!v.leftAt).map(v=>[v.id,v.activeAt??v.at]));
    const lazy=checkinProfileFromOpen(before,next.visits.filter(v=>v.branch===branch&&!v.leftAt).map(({id,member,at,activeAt})=>({id,member,at,...(activeAt?{activeAt}:{})})),members,NOW);
    assert.equal(lazy,checkinProfile(prev,next,branch,NOW));
  }
  assert.equal(checkinProfileFromOpen(null,[],new Set(),NOW),null);
  const b=cur.visits[0].branch;await db.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{leftAt}','\"\"') WHERE owner_id='O1' AND entity_id=$1".replace('$1',"'"+cur.visits[0].id+"'"));
  assert.deepEqual(await readOpenVisits(scope,{owner:'O1',branch:b}),{status:'unavailable',reason:'falsy-leftAt'});
});
