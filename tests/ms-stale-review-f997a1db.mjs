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

const {readAttendance,IRREGULAR_PAGE}=await import('../app/lib/attendance-page.ts');
const scope=(o,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);return work(c);});
const oddAts=['2026-03-15T09:00:00Z','2026-03-15t10:00:00.000z'];
test('stale page result must not be cached for the correct version',async()=>{
  const s=fixture();s.visits=[];for(let i=0;i<1100;i++)s.visits.push({id:'h'+String(i).padStart(4,'0'),member:'plain',branch:'a',day:'2026-03-15',at:oddAts[i%2],leftAt:'x'});await seed('S1',s);
  const q={owner:'S1',branch:'a',day:'2026-03-15'};
  const p1=await readAttendance(scope,q);assert.equal(p1.status,'irregular');const v0=p1.version;
  // a writer lands after page 1
  await db.query("UPDATE gymos.gym_entities SET payload=payload||'{\"x\":1}'::jsonb WHERE owner_id='S1' AND collection='visits' AND entity_id='h0001'");
  const stale=await readAttendance(scope,{...q,after:p1.next,ver:v0});console.log('page2 with old ver:',stale.status);
  // client restarts: new page 1 at the new version, then page 2 with the NEW version
  const r1=await readAttendance(scope,q);console.log('restart page1 version changed:',r1.version!==v0);
  const r2=await readAttendance(scope,{...q,after:r1.next,ver:r1.version});console.log('restart page2 with correct ver:',r2.status);
  assert.equal(r2.status,'irregular','a correct restart must succeed');
});
