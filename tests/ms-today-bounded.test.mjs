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

const {readTodayVisits}=await import('../app/lib/today-visits.ts');
const {readAttendance}=await import('../app/lib/attendance-page.ts');
const {pickNewest,mergeNewest}=await import('../app/use-attendance.ts');
const {clientAttendance}=await import('./att-client-sim.mjs');
const {boundedRead,clearBoundedReadCache}=await import('../app/lib/bounded-read.ts');
let sd=4242;const rnd=()=>{sd=(sd*1664525+1013904223)>>>0;return sd/2**32;};const pick=a=>a[Math.floor(rnd()*a.length)];
const scopeOf=()=>(o,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);return work(c);});
test('attendance differential vs legacy page expressions, fallback on irregular values, cache invalidates on writes',async()=>{
  let cmp=0,irr=0;const scope=scopeOf();
  for(let run=0;run<6;run++){
    const s=fixture();s.branches.push({id:'c',name:'C'});
    for(const m of s.members){m.branch=pick(['a','b','c']);if(rnd()<.2)m.demo=true;if(rnd()<.2)m.archived=true;}
    s.visits=[];const days=['2026-03-14','2026-03-15','2026-03-16'];
    for(let i=0;i<260;i++){const m=pick(s.members);const d=pick(days);const hh=String(8+Math.floor(rnd()*3)).padStart(2,'0');s.visits.push({id:'q'+run+'v'+i,member:rnd()<.1?'ghost'+i:m.id,branch:pick(['a','b','c']),day:d,at:d+'T'+hh+':00:00.000Z',leftAt:d+'T'+hh+':30:00.000Z'});}
    s.payments=[];s.invoices=[];
    const owner='A'+run;await seed(owner,s);let cur=await current(owner);
    for(const branch of ['a','b','c'])for(const day of days){
      const vs=cur.visits.filter(v=>v.branch===branch);
      const out=await readAttendance(scope,{owner,branch,day});assert.equal(out.status,'ok');
      assert.equal(out.todayCount,vs.filter(v=>v.day===day).length,'today');
      assert.deepEqual(out.rows.map(v=>v.id),[...vs].sort((a,b)=>b.day.localeCompare(a.day)||b.at.localeCompare(a.at)).slice(0,100).map(v=>v.id),'rows');cmp++;}
    // cache: a write bumps the version, so the next read reflects it
    const before=await readAttendance(scope,{owner,branch:'a',day:days[0]});
    await db.query("UPDATE gymos.gym_entities SET payload=payload||'{\"day\":\"2026-03-14\"}'::jsonb WHERE owner_id=$1 AND collection='visits' AND payload->>'branch'='a' AND entity_id=(SELECT entity_id FROM gymos.gym_entities WHERE owner_id=$1 AND collection='visits' AND payload->>'branch'='a' AND payload->>'day'<>'2026-03-14' LIMIT 1)",[owner]);
    const again=await readAttendance(scope,{owner,branch:'a',day:days[0]});
    const truth=(await current(owner)).visits.filter(v=>v.branch==='a'&&v.day===days[0]).length;assert.equal(again.todayCount,truth,'fresh after write');
    // irregular day falls back
    await db.query("UPDATE gymos.gym_entities SET payload=payload||'{\"at\":\"2026-3-14 10:00\"}'::jsonb WHERE owner_id=$1 AND collection='visits' AND entity_id=(SELECT entity_id FROM gymos.gym_entities WHERE owner_id=$1 AND collection='visits' AND branch='a' LIMIT 1)",[owner]);
    const bad=await readAttendance(scope,{owner,branch:'a',day:days[0]});
    const br=(await db.query("SELECT branch FROM gymos.gym_entities WHERE owner_id=$1 AND collection='visits' AND payload->>'at'='2026-3-14 10:00'",[owner])).rows[0]?.branch;
    assert.equal(bad.status,br==='a'?'irregular':'ok');
    if(bad.status==='irregular'){
      const vs=(await current(owner)).visits.filter(v=>v.branch==='a');
      assert.equal(bad.todayCount,vs.filter(v=>v.day===days[0]).length);
      const got=(await clientAttendance(scope,{owner,branch:'a',day:days[0]},{readAttendance,mergeNewest,pickNewest})).rows.map(v=>v.id);
      assert.deepEqual(got,[...vs].sort((a,b)=>b.day.localeCompare(a.day)||b.at.localeCompare(a.at)).slice(0,100).map(v=>v.id),'irregular exact legacy order');
      irr++;
    }
    const o2=await readAttendance(scope,{owner:'nobody',branch:'a',day:days[0]});assert.equal(o2.status,'ok');assert.equal(o2.rows.length,0);
  }
  console.log('attendance comparisons',cmp,'irregular',irr);assert.ok(irr>0);
});
test('bounded read: timeout aborts the read; cache serves the same version once',async()=>{
  const scope=scopeOf();clearBoundedReadCache();let runs=0;
  const a=await scope('A0',c=>boundedRead(c,'A0','k',async()=>{runs++;return{n:1};}));
  const b=await scope('A0',c=>boundedRead(c,'A0','k',async()=>{runs++;return{n:2};}));
  assert.deepEqual(a,{n:1});assert.deepEqual(b,{n:1});assert.equal(runs,1);
  // statement_timeout enforcement is a real-Postgres behaviour (PGlite does not enforce it): see tests/bounded-timeout.pg.mjs
});
test('57014 is converted so the pool retry text match cannot repeat the query',async()=>{
  const {ReadBudgetError}=await import('../app/lib/bounded-read.ts');clearBoundedReadCache();let calls=0;
  const fake={async query(sql){if(/set_config/.test(sql))return{rows:[]};if(/to_regclass/.test(sql))return{rows:[{ok:false}]};return{rows:[]};}};
  await assert.rejects(boundedRead(fake,'o','k',async()=>{calls++;const e=new Error('canceling statement due to statement timeout');e.code='57014';throw e;}),e=>e instanceof ReadBudgetError&&!/timeout|503|Connection/.test(e.message));
  assert.equal(calls,1);
});
test('irregular branches above one page are exact through paging, no cap; version read 57014 is also converted',async()=>{
  const {IRREGULAR_PAGE}=await import('../app/lib/attendance-page.ts');const {ReadBudgetError}=await import('../app/lib/bounded-read.ts');
  const {pickNewest,mergeNewest}=await import('../app/use-attendance.ts');const {clientAttendance}=await import('./att-client-sim.mjs');
  const s=fixture();s.visits=[];const ats=['2026-03-15T09:00:00Z','2026-03-15T09:00:00.000Z','2026-03-16t01:00:00.000z','2026-03-14T09:00:00+02:00'];
  for(let i=0;i<IRREGULAR_PAGE*3+37;i++)s.visits.push({id:'x'+i,member:'plain',branch:'a',day:'2026-03-1'+(4+i%3),at:ats[i%4],leftAt:'2026-03-17T00:00:00.000Z'});
  await seed('CAP',s);const cur=await current('CAP');const vs=cur.visits.filter(v=>v.branch==='a');
  const out=await clientAttendance(scopeOf(),{owner:'CAP',branch:'a',day:'2026-03-15'},{readAttendance,mergeNewest,pickNewest});
  assert.ok(out.pages>=2);assert.equal(out.todayCount,vs.filter(v=>v.day==='2026-03-15').length);
  assert.deepEqual(out.rows.map(v=>v.id),[...vs].sort((a,b)=>b.day.localeCompare(a.day)||b.at.localeCompare(a.at)).slice(0,100).map(v=>v.id));
  clearBoundedReadCache();const fake={async query(sql){if(/to_regclass/.test(sql)){const e=new Error('canceling statement due to statement timeout');e.code='57014';throw e;}return{rows:[]};}};
  await assert.rejects(boundedRead(fake,'o','k',async()=>1),e=>e instanceof ReadBudgetError);
});
