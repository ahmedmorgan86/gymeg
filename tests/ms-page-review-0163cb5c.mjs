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
let sd=31;const rnd=()=>{sd=(sd*1664525+1013904223)>>>0;return sd/2**32;};const pick=a=>a[Math.floor(rnd()*a.length)];
const {mergeNewest}=await import('../app/use-attendance.ts');
// Same protocol as app/use-attendance.ts: pages carry the version of page 1; 'stale' restarts (max 3 attempts).
async function client(owner,branch,between){for(let attempt=0;attempt<3;attempt++){
  const d=await readAttendance(scope,{owner,branch,day:'2026-03-15'});if(d.status==='ok')return d.rows.map(r=>r.id);if(d.status!=='irregular'){continue;}
  let run=mergeNewest([...d.canonical,...d.candidates],100),next=d.next,pages=1,stale=false;
  while(next!==null){if(between&&pages===1&&attempt===0)await between();const pg=await readAttendance(scope,{owner,branch,day:'2026-03-15',after:next,ver:d.version});if(pg.status==='stale'){stale=true;break;}run=mergeNewest([...run,...pg.candidates],100);next=pg.next;pages++;}
  if(stale)continue;
  return [...run].sort((a,b)=>b.p.day.localeCompare(a.p.day)||b.p.at.localeCompare(a.p.at)).map(c=>c.p.id);}
  throw new Error('failed after restarts');}
const oddAts=['2026-03-15T09:00:00Z','2026-03-15t10:00:00.000z','2026-03-14T23:00:00+02:00','2026-03-16T09:00:00Z'];
function build(N){const s=fixture();s.visits=[];for(let i=0;i<N;i++){const d='2026-03-'+pick(['10','11','12','13','14','15']);const odd=rnd()<.6;s.visits.push({id:'g'+i,member:'plain',branch:'a',day:d,at:odd?pick(oddAts):d+'T'+pick(['08','10'])+':00:00.000Z',leftAt:'x'});}return s;}
test('multipage == legacy; concurrent write between pages; duplicate positions',async()=>{
  const s=build(1400);await seed('P1',s);const cur=await current('P1');const vis=cur.visits.filter(v=>v.branch==='a');
  const want=[...vis].sort((a,b)=>b.day.localeCompare(a.day)||b.at.localeCompare(a.at)).slice(0,100).map(v=>v.id);
  const odd=vis.filter(v=>!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.at)).length;console.log('odd rows',odd,'pages',Math.ceil(odd/IRREGULAR_PAGE));
  assert.deepEqual(await client('P1','a'),want,'multipage parity');
  // concurrent: delete the current newest odd row between page 1 and 2 -> client result includes a row that no longer exists
  const gone=want.find(id=>vis.find(v=>v.id===id)&&!/\.\d{3}Z$/.test(vis.find(v=>v.id===id).at));
  const res=await client('P1','a',async()=>{await db.query("DELETE FROM gymos.gym_entities WHERE owner_id='P1' AND collection='visits' AND entity_id=$1",[want[0]]);});
  const after=(await current('P1')).visits.filter(v=>v.branch==='a');assert.deepEqual(res,[...after].sort((a,b)=>b.day.localeCompare(a.day)||b.at.localeCompare(a.at)).slice(0,100).map(v=>v.id),'restart gives the post-write answer');assert.ok(!res.includes(want[0]));
  // duplicate positions at the page boundary
  const s2=build(1400);await seed('P2',s2);await db.query("UPDATE gymos.gym_entities SET position=position WHERE owner_id='P2'");
  const rows=(await db.query("SELECT entity_id,position FROM gymos.gym_entities WHERE owner_id='P2' AND collection='visits' AND branch='a' AND (payload->>'at') !~ '\\.\\d{3}Z$' ORDER BY position")).rows;
  const b=rows[IRREGULAR_PAGE-1],nx=rows[IRREGULAR_PAGE];await db.query("UPDATE gymos.gym_entities SET position=$1 WHERE owner_id='P2' AND collection='visits' AND entity_id=$2",[b.position,nx.entity_id]);
  const d=await readAttendance(scope,{owner:'P2',branch:'a',day:'2026-03-15'});const pg2=await readAttendance(scope,{owner:'P2',branch:'a',day:'2026-03-15',after:d.next,ver:d.version});
  const seen=new Set([...d.candidates,...pg2.candidates].map(c=>c.p.id));assert.ok(seen.has(nx.entity_id),'row sharing the boundary position is not dropped');
  const full=await client('P2','a');const v2=(await current('P2')).visits.filter(v=>v.branch==='a');assert.deepEqual(full,[...v2].sort((a,b)=>b.day.localeCompare(a.day)||b.at.localeCompare(a.at)).slice(0,100).map(v=>v.id),'duplicate-position parity');
});
