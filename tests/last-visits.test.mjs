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
const {readLastVisits}=await import('../app/lib/last-visits-page.ts');
const scope=(o,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);return work(c);});
let sd=3;const rnd=()=>{sd=(sd*1664525+1013904223)>>>0;return sd/2**32;};const pick=a=>a[Math.floor(rnd()*a.length)];
const iso=(d,h)=>d+'T'+String(h).padStart(2,'0')+':00:00.000Z';
test('last visits per member == the legacy loop; odd data fails closed',async()=>{
  const s=fixture();s.visits=[];s.payments=[];s.invoices=[];s.branches.push({id:'c',name:'C'});
  for(const m of s.members)m.branch=pick(['a','b','c']);
  const days=['2026-03-01','2026-03-09','2026-03-14','2026-03-15','2026-04-02','2025-12-31'];let n=0;
  for(let k=0;k<1200;k++){const m=pick(s.members),d=pick(days);s.visits.push({id:'v'+n++,member:rnd()<.05?'ghost':m.id,branch:pick(['a','b','c']),day:d,at:iso(d,k%24),leftAt:iso(d,(k%24)),method:'x'});}
  await seed('L1',s);const cur=await current('L1');
  for(const branch of ['a','b','c'])for(const today of ['2026-03-14','2025-12-30','2027-01-01','9999-12-31']){
    const legacy=new Map();for(const v of cur.visits)if(v.branch===branch&&v.day<=today&&v.day>(legacy.get(v.member)??''))legacy.set(v.member,v.day);
    const r=await readLastVisits(scope,{owner:'L1',branch,today});assert.equal(r.status,'ok');
    for(const m of cur.members.filter(m=>m.branch===branch))assert.equal(r.last[m.id],legacy.get(m.id),branch+today+m.id);assert.ok(Object.keys(r.last).every(id=>cur.members.some(m=>m.id===id&&m.branch===branch)));
    if(today==='9999-12-31')for(const m of cur.members.filter(m=>m.branch===branch))assert.equal(r.last[m.id],cur.visits.filter(v=>v.branch===branch&&v.member===m.id).map(v=>v.day).sort().at(-1),'members-table expression (no day clamp) '+branch+m.id);
  }
  await db.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{day}','\"2026-3-9\"') WHERE owner_id='L1' AND entity_id='v1'");
  const bad=cur.visits.find(v=>v.id==='v1').branch;
  assert.deepEqual(await readLastVisits(scope,{owner:'L1',branch:bad,today:'2026-03-14'}),{status:'unavailable',reason:'non-canonical-visit'});
  await db.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{day}','\"2026-03-09\"') WHERE owner_id='L1' AND entity_id='v1'");
  const first=cur.visits.find(v=>v.id==='v2');await db.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{member}','5') WHERE owner_id='L1' AND entity_id='v2'");
  assert.deepEqual(await readLastVisits(scope,{owner:'L1',branch:first.branch,today:'2026-03-14'}),{status:'unavailable',reason:'non-string-member'});
  await assert.rejects(readLastVisits(scope,{owner:'L1',branch:'a',today:'x'}),RangeError);
});
