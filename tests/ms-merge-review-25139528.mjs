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
const {pickNewest,mergeNewest}=await import('../app/use-attendance.ts');const {clientAttendance}=await import('./att-client-sim.mjs');
let sd=4242;const rnd=()=>{sd=(sd*1664525+1013904223)>>>0;return sd/2**32;};const pick=a=>a[Math.floor(rnd()*a.length)];
const scope=(o,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);return work(c);});
test('irregular candidate merge == legacy top100 (random)',async()=>{
  let cmp=0;
  const odd=[['2026-03-15T09:00:00Z','2026-03-15'],['2026-03-15t10:00:00.000z','2026-03-15'],['2026-03-14T23:00:00+02:00','2026-03-14'],['2026-3-5T09:00:00.000Z','2026-3-5'],['2026-03-15T09:00:00.000Z',''],['2026-03-15 09:00','2026-03-15']];
  for(let run=0;run<6;run++){
    const s=fixture();s.visits=[];const N=300+Math.floor(rnd()*100);
    for(let i=0;i<N;i++){const d='2026-03-'+pick(['10','11','12','13','14','15']);let day=d,at=d+'T'+pick(['08','09','10','11'])+':'+pick(['00','30'])+':00.000Z';
      if(rnd()<.06){const o=pick(odd);at=o[0];if(rnd()<.5&&o[1])day=o[1];}
      s.visits.push({id:'m'+run+'v'+i,member:'plain',branch:pick(['a','a','b']),day,at,leftAt:at});}
    const owner='M'+run;await seed(owner,s);const cur=await current(owner);
    for(const branch of ['a','b']){
      const vis=cur.visits.filter(v=>v.branch===branch);
      const out=await readAttendance(scope,{owner,branch,day:'2026-03-15'});
      assert.equal(out.todayCount??-1,vis.filter(v=>v.day==='2026-03-15').length,'todayCount');
      const want=[...vis].sort((a,b)=>b.day.localeCompare(a.day)||b.at.localeCompare(a.at)).slice(0,100).map(v=>v.id);
      if(out.status==='ok'){assert.deepEqual(out.rows.map(r=>r.id),want);}
      else{assert.equal(out.status,'irregular');const got=(await clientAttendance(scope,{owner,branch,day:'2026-03-15'},{readAttendance,mergeNewest,pickNewest})).rows.map(v=>v.id);assert.deepEqual(got,want,'merge run'+run+branch);}
      cmp++;}
  }
  console.log('merge comparisons',cmp);
});
test('cap and planner setting cleanup',async()=>{
  const s=fixture();s.visits=[];for(let i=0;i<IRREGULAR_PAGE+5;i++)s.visits.push({id:'c'+i,member:'plain',branch:'a',day:'2026-03-15',at:'2026-03-15T09:00:00Z',leftAt:'x'});await seed('CAP',s);
  const out=await readAttendance(scope,{owner:'CAP',branch:'a',day:'2026-03-15'});assert.equal(out.status,'irregular');assert.ok(out.next!==null);
  const seq=await db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner','CAP',true)");await readAttendance((o,w)=>w(c),{owner:'CAP',branch:'a',day:'2026-03-15'}).catch(()=>{});return (await c.query("SHOW enable_seqscan")).rows[0].enable_seqscan;});
  console.log('enable_seqscan after read in same tx:',seq);
});
