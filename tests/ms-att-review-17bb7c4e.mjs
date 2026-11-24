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

const {readAttendance}=await import('../app/lib/attendance-page.ts');const {readTodayVisits}=await import('../app/lib/today-visits.ts');const {clearBoundedReadCache}=await import('../app/lib/bounded-read.ts');
let sd=99;const rnd=()=>{sd=(sd*1664525+1013904223)>>>0;return sd/2**32;};const pick=a=>a[Math.floor(rnd()*a.length)];
const scope=(o,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);return work(c);});
test('attendance + today differential, cache isolation across owners/versions',async()=>{
  let cmp=0;
  for(let run=0;run<6;run++){
    const s=fixture();s.branches.push({id:'c',name:'C'});for(const m of s.members){m.branch=pick(['a','b','c']);if(rnd()<.2)m.demo=true;if(rnd()<.2)m.archived=true;}
    s.visits=[];let n=0;const days=['2026-03-10','2026-03-14','2026-03-15'];
    for(let i=0;i<260;i++){const m=pick(s.members);const d=pick(days);s.visits.push({id:'q'+run+'v'+n++,member:m.id,branch:pick(['a','b','c']),day:d,at:d+'T'+pick(['08','09','10','11'])+':00:00.000Z',leftAt:d+'T23:00:00.000Z'});}
    s.payments=[];s.invoices=[];const owner='A'+run;await seed(owner,s);const cur=await current(owner);clearBoundedReadCache();
    for(const branch of ['a','b','c'])for(const day of days){
      const vis=cur.visits.filter(v=>v.branch===branch);
      const out=await readAttendance(scope,{owner,branch,day});assert.equal(out.status,'ok');
      assert.equal(out.todayCount,vis.filter(v=>v.day===day).length,'todayCount');
      assert.deepEqual(out.rows.map(r=>r.id),[...vis].sort((a,b)=>b.day.localeCompare(a.day)||b.at.localeCompare(a.at)).slice(0,100).map(v=>v.id),'rows '+branch+day);cmp++;
      // cached second read equal
      const again=await readAttendance(scope,{owner,branch,day});assert.deepEqual(again,out);
    }
    // cache isolation: same branch/day key, different owner must not return this owner's data
    const other='B'+run;await seed(other,fixture());const o=await readAttendance(scope,{owner:other,branch:'a',day:days[0]});
    assert.notDeepEqual(o.rows.map(r=>r.id),(await readAttendance(scope,{owner,branch:'a',day:days[0]})).rows.map(r=>r.id));
    // writer invalidates: insert a visit directly and the read changes
    const before=await readAttendance(scope,{owner,branch:'a',day:days[2]});
    await db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,'visits','newv',99999,'a',$2)",[owner,JSON.stringify({id:'newv',member:'plain',branch:'a',day:days[2],at:'2026-03-15T23:00:00.000Z',leftAt:'2026-03-15T23:30:00.000Z'})]);
    const after=await readAttendance(scope,{owner,branch:'a',day:days[2]});assert.equal(after.todayCount,before.todayCount+1,'direct SQL write invalidates cache');assert.equal(after.rows[0].id,'newv');
    // irregular -> fallback
    await db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,'visits','odd',99998,'a',$2)",[owner,JSON.stringify({id:'odd',member:'plain',branch:'a',day:'2026-03-15',at:'2026-03-15T09:00:00Z'})]);
    assert.equal((await readAttendance(scope,{owner,branch:'a',day:days[2]})).status,'irregular');
  }
  console.log('attendance comparisons',cmp);
});
