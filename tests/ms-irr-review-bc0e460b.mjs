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
const AS='2026-03-14T00:00:00.000Z'; // compute clock for the stored horizon (2026-03-13), before every test clock
async function current(owner){const r=await db.query("SELECT collection,payload FROM gymos.gym_entities WHERE owner_id=$1 ORDER BY position,entity_id",[owner]);const s=fixture();const by=c=>r.rows.filter(x=>x.collection===c).map(x=>x.payload);s.members=by('members');s.visits=by('visits');s.payments=by('payments');s.invoices=by('invoices');return s;}

const {readAttendance}=await import('../app/lib/attendance-page.ts');
const scope=(o,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);return work(c);});
test('irregular attendance path + ids',async()=>{
  const s=fixture();s.visits=[];const mk=(i,b,day,at)=>s.visits.push({id:'w'+i,member:'plain',branch:b,day,at,leftAt:at});
  const ats=['2026-03-15T09:00:00.000Z','2026-03-15T09:00:00Z','2026-03-15t10:00:00.000z','2026-03-14T23:00:00.000Z','2026-03-15T09:00:00+02:00'];
  for(let i=0;i<130;i++)mk(i,'a','2026-03-1'+(i%6),ats[i%5]);for(let i=130;i<140;i++)mk(i,'b','2026-03-15',ats[0]);
  await seed('I1',s);const cur=await current('I1');
  const out=await readAttendance(scope,{owner:'I1',branch:'a',day:'2026-03-15'});assert.equal(out.status,'irregular');
  const vis=cur.visits.filter(v=>v.branch==='a');
  assert.equal(out.todayCount,vis.filter(v=>v.day==='2026-03-15').length);
  const {pickNewest}=await import('../app/use-attendance.ts');
  const want=[...vis].sort((a,b)=>b.day.localeCompare(a.day)||b.at.localeCompare(a.at)).slice(0,100).map(v=>v.id);
  assert.deepEqual(pickNewest(out.candidates,100).map(v=>v.id),want,'exact legacy order from the bounded candidate set');
  assert.ok(out.candidates.length<=600,'bounded candidates');
  assert.ok(out.candidates.every(v=>v.branch==='a'),'branch isolation');
  const o2=await readAttendance(scope,{owner:'nobody',branch:'a',day:'2026-03-15'});assert.equal(o2.status,'ok');assert.equal(o2.rows.length,0);
  console.log('candidates',out.candidates.length,'of',vis.length);
});
