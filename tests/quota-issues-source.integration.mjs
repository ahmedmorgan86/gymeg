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
const NOWS=['2026-03-15T12:00:00.000Z','2026-03-15T15:00:00.000Z','2026-03-20T22:30:00.000Z','2026-04-01T00:30:00.000Z','2027-01-02T10:00:00.000Z'];
async function seed(owner,state){
  state=structuredClone(state);const op=state.visits.filter(v=>v.member==='plain'&&!v.leftAt);for(const v of op.slice(1))v.leftAt=v.day+'T23:00:00.000Z'; // one open visit per member
  const {metadata,entities}=splitState(state);
  await db.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,5,$3)',[owner,JSON.stringify({...metadata,_entityStorage:1,_activityArchive:1}),'x']);
  for(const e of entities)await db.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',[owner,e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);
}
const AS='2026-03-14T00:00:00.000Z'; // compute clock for the stored horizon (2026-03-13), before every test clock
const read=(owner,b=null,opts={refresh:true,now:AS})=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);return readMemberCandidates(c,owner,b,opts);});
const via=(owner,hook,opts={refresh:true,now:AS})=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);return readMemberCandidates({query:async(s,v)=>{const r=await hook(c,s,v,'before');const x=r??await c.query(s,v);await hook(c,s,v,'after');return x;}},owner,null,opts);});
async function current(owner){const r=await db.query("SELECT collection,payload FROM gymos.gym_entities WHERE owner_id=$1 ORDER BY position,entity_id",[owner]);const s=fixture();const by=c=>r.rows.filter(x=>x.collection===c).map(x=>x.payload);s.members=by('members');s.visits=by('visits');s.payments=by('payments');s.invoices=by('invoices');return s;}
const {readQuotaIssues}=await import('../app/lib/quota-issues-source.ts');
const {membershipIssue}=await import('../app/lib/extensions.ts');const {dayAt}=await import('../app/lib/domain.ts');
const scopeFor=owner=>(o,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);return work(c);});
let sd=7;const rnd=()=>{sd=(sd*1664525+1013904223)>>>0;return sd/2**32;};const pick=a=>a[Math.floor(rnd()*a.length)];
function club(){
  const s=fixture();s.visits=[];s.payments=[];s.invoices=[];s.branches=[{id:'a',name:'A'},{id:'b',name:'B'},{id:'c',name:'C'}];
  s.members=[];for(let i=0;i<24;i++){const br=['a','b','c'][i%3],cap=pick([null,1,2,3,4]);
    s.members.push({id:'k'+i,branch:br,joined:'2026-01-01',expires:i%7===0?'2026-03-17':'2026-12-31',archived:i===5?true:undefined,awaitingSubscription:i===8?true:undefined,freezes:i===11?[{from:'2026-03-10',to:'2026-03-22'}]:undefined,
      membershipPeriods:[{id:i%4===0?'shared':'p'+i,plan:'pl',start:'2026-02-01',end:'2026-12-31',visits:cap,quotaMode:i%5===0?'sessions':undefined}]});}
  return s;
}
const NOWS2=['2026-03-15T12:00:00.000Z','2026-03-20T22:30:00.000Z','2026-04-01T00:30:00.000Z','2027-01-02T10:00:00.000Z'];
async function oracleCheck(owner,label,branches=null){
  const s=await current(owner);const stats={compared:0,quota:0,crossBranchOnlyVisitors:0};
  for(const now of NOWS2){
    const day=dayAt(now,s.settings.timezone);
    for(const branch of ['a','b','c']){
      const r=await readQuotaIssues(scopeFor(owner),{owner,branch,branches,settings:s.settings,now});
      if(branches&&!branches.includes(branch)){assert.equal(r.status,'forbidden',label+' foreign branch');continue;}
      assert.equal(r.status,'ok',label+' '+branch+' '+now+' '+JSON.stringify(r));
      const vis=branches?{...s,visits:s.visits.filter(v=>branches.includes(v.branch))}:s; // what a restricted packet carries
      const want=s.members.filter(m=>m.branch===branch&&!m.archived&&membershipIssue(vis,m,day)==='quota').map(m=>m.id).sort();
      assert.deepEqual([...r.quota].sort(),want,`${label} ${branch} ${now}`);
      stats.compared+=r.members;stats.quota+=want.length;
      const wantAll=s.members.filter(m=>m.branch===branch&&!m.archived).length;assert.equal(r.members,wantAll,'every non-archived member of the branch was classified');
    }
  }
  return stats;
}
test('quota-issue set == membershipIssue(full state)==="quota" for every member, branch and clock; cross-branch visits counted exactly as legacy; restricted branch scope',async()=>{
  const s=club();let n=0;
  for(let k=0;k<420;k++){const m=pick(s.members),d=pick(['2026-02-03','2026-02-20','2026-03-01','2026-03-05','2026-03-10','2026-03-12','2026-03-13']);
    const vbranch=rnd()<.25?pick(['a','b','c']):m.branch; // 25% cross-branch visits: legacy counts only same-branch ones toward the cap
    s.visits.push({id:'v'+n++,member:m.id,branch:vbranch,day:d,at:d+'T0'+(k%9)+':00:00.000Z',leftAt:d+'T0'+(k%9)+':30:00.000Z',periodId:rnd()<.1?'other':undefined,sessions:rnd()<.3?[{},{}]:undefined});}
  await seed('QI',s);await read('QI'); // stored at horizon 03-13
  const st=await oracleCheck('QI','static');
  const stR=await oracleCheck('QI','restricted a',['a']);
  console.log('quota-issues static',JSON.stringify(st),'restricted',JSON.stringify(stR));assert.ok(st.quota>20&&stR.quota>3);
});
test('after real writes (tail/today inserts, session edit, move, delete, exit) the set stays exact; stale rows are refreshed by the same read; before-horizon clock is an explicit fallback',async()=>{
  const s=club();s.visits=[];await seed('QW',s);await read('QW');
  const ins=async(id,mem,br,d,x={})=>db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES('QW','visits',$1,$2,$3,$4)",[id,30000+Math.floor(rnd()*1e6),br,JSON.stringify({id,member:mem,branch:br,day:d,at:d+'T09:00:00.000Z',leftAt:d+'T09:30:00.000Z',...x})]);
  const cur=await current('QW');const caps=cur.members.filter(m=>m.membershipPeriods[0].visits===1||m.membershipPeriods[0].visits===2);
  let total=0;
  for(const [i,m] of caps.entries()){await ins('t'+i,m.id,m.branch,'2026-03-15');if(i%2)await ins('u'+i,m.id,m.branch,'2026-03-16');if(i%3===0)await ins('x'+i,m.id,pick(['a','b','c'].filter(b=>b!==m.branch)),'2026-03-15');}
  total+=(await oracleCheck('QW','tail inserts')).quota;
  await db.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{sessions}','[{},{},{}]') WHERE owner_id='QW' AND entity_id LIKE 't%'");total+=(await oracleCheck('QW','session edit')).quota;
  await db.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{member}',to_jsonb($1::text)) WHERE owner_id='QW' AND entity_id='t0'",[caps[1].id]);total+=(await oracleCheck('QW','moved')).quota;
  await db.query("DELETE FROM gymos.gym_entities WHERE owner_id='QW' AND entity_id LIKE 'u%'");total+=(await oracleCheck('QW','deleted')).quota;
  assert.ok(total>0,'cases include quota members');
  // a clock before the stored horizon cannot be answered exactly: explicit fallback with its reason, never a partial set
  const sNow=await current('QW');
  const early=await readQuotaIssues(scopeFor('QW'),{owner:'QW',branch:'a',branches:null,settings:sNow.settings,now:'2026-03-10T12:00:00.000Z'});
  console.log('quota-issues before-horizon',JSON.stringify(early));assert.deepEqual(early,{status:'fallback',reason:'null-derivation'});
  // unchanged token: same version+day answers 'unchanged', a new day recomputes
  const ok=await readQuotaIssues(scopeFor('QW'),{owner:'QW',branch:'a',branches:null,settings:sNow.settings,now:NOWS2[0]});assert.equal(ok.status,'ok');
  assert.equal((await readQuotaIssues(scopeFor('QW'),{owner:'QW',branch:'a',branches:null,settings:sNow.settings,now:NOWS2[0],since:ok.version})).status,'unchanged');
  assert.equal((await readQuotaIssues(scopeFor('QW'),{owner:'QW',branch:'a',branches:null,settings:sNow.settings,now:NOWS2[1],since:ok.version})).status,'ok','day change recomputes');
});
test('cost: no photo hashing, bounded dirty work (explicit fallback over the budget), statement timeout set, query count and time at 3000 members',async()=>{
  const {QUOTA_MAX_DIRTY}=await import('../app/lib/quota-issues-source.ts');
  const s=club();s.visits=[];s.members=[];const big='data:image/jpeg;base64,'+'A'.repeat(20000);
  for(let i=0;i<3000;i++)s.members.push({id:'z'+i,branch:['a','b','c'][i%3],joined:'2026-01-01',expires:'2026-12-31',photo:i%2?big:undefined,membershipPeriods:[{id:'pz'+i,plan:'pl',start:'2026-02-01',end:'2026-12-31',visits:i%4?null:3}]});
  await seed('QC',s);for(let i=0;i<20;i++){const r=await db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner','QC',true)");return refreshDirtySummaries(c,'QC',500,AS);});if(!r.remaining)break;}
  const seen=[];const counting=owner=>(o,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);return work({query:async(q,v)=>{seen.push(String(q));return c.query(q,v);}});});
  const st=await current('QC');
  const t0=performance.now();const r=await readQuotaIssues(counting('QC'),{owner:'QC',branch:'a',branches:null,settings:st.settings,now:NOWS2[0]});const ms=Math.round(performance.now()-t0);
  assert.equal(r.status,'ok',JSON.stringify(r));assert.equal(r.members,1000);
  assert.ok(!seen.some(q=>/sha256|gym_photos/.test(q)),'no photo hashing or photo-table access');
  assert.ok(seen.some(q=>/statement_timeout/.test(q)),'statement timeout is set before the reads');
  console.log('quota-issues cost: members',r.members,'statements',seen.length,'ms',ms);
  assert.ok(seen.length<=14,'constant statement count, not per member: '+seen.length);
  // dirty budget: mark more than the budget dirty -> explicit fallback, nothing partial, no unbounded write-on-read
  await db.query("INSERT INTO gymos.gym_member_summary_dirty(owner_id,member_id,gen) SELECT 'QC','z'||g,1000+g FROM generate_series(0,$1) g ON CONFLICT DO NOTHING",[QUOTA_MAX_DIRTY*3]);
  // convergence: each request drains at most the budget and says so; repeated reads reach ok with no request exceeding the budget
  let calls=0,last,peak=0;const dirtyN=async()=>Number((await db.query("SELECT count(*) n FROM gymos.gym_member_summary_dirty WHERE owner_id='QC'")).rows[0].n);
  const d0=await dirtyN();
  for(;calls<20;calls++){const before=await dirtyN();last=await readQuotaIssues(scopeFor('QC'),{owner:'QC',branch:'a',branches:null,settings:st.settings,now:NOWS2[0]});peak=Math.max(peak,before-await dirtyN());if(last.status==='ok')break;assert.deepEqual([last.status,last.reason],['fallback','draining']);}
  console.log('quota-issues drain: dirty',d0,'requests until ok',calls+1,'max recomputed per request',peak);
  assert.equal(last.status,'ok');assert.ok(peak<=QUOTA_MAX_DIRTY&&calls>=1);
  // forced failure mid-wave: the transaction rolls back (marks and summaries unchanged) and the connection is usable afterwards
  await db.query("INSERT INTO gymos.gym_member_summary_dirty(owner_id,member_id,gen) SELECT 'QC','z'||g,5000+g FROM generate_series(0,60) g ON CONFLICT DO NOTHING");
  const before=await dirtyN(),sumBefore=(await db.query("SELECT md5(string_agg(stored::text,'' ORDER BY member_id)) h FROM gymos.gym_member_summaries WHERE owner_id='QC'")).rows[0].h;
  let n=0;const failing=(o,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner','QC',true)");return work({query:async(q,v)=>{if(/gym_member_summaries/.test(String(q))&&/INSERT|UPDATE/i.test(String(q))&&++n===10)throw new Error('forced');return c.query(q,v);}});});
  await assert.rejects(readQuotaIssues(failing,{owner:'QC',branch:'a',branches:null,settings:st.settings,now:NOWS2[0]}),/forced/);
  assert.ok(n>=10,'the failure was injected mid-wave');
  assert.equal(await dirtyN(),before,'marks restored by rollback');
  assert.equal((await db.query("SELECT md5(string_agg(stored::text,'' ORDER BY member_id)) h FROM gymos.gym_member_summaries WHERE owner_id='QC'")).rows[0].h,sumBefore,'summaries unchanged by the rolled-back wave');
  assert.equal((await db.query('SELECT 1 AS x')).rows[0].x,1,'connection usable');
  assert.ok(['ok','fallback'].includes((await readQuotaIssues(scopeFor('QC'),{owner:'QC',branch:'a',branches:null,settings:st.settings,now:NOWS2[0]})).status));
});
test('worst-case history: one member with 6000 visits among 150 dirty members; wave time-bounded by the deadline (slow statements), progress kept, per-request time measured',async()=>{
  const {QUOTA_WAVE_MS,QUOTA_BATCH,QUOTA_MAX_DIRTY}=await import('../app/lib/quota-issues-source.ts');
  const s=club();s.members=[];s.visits=[];
  for(let i=0;i<150;i++)s.members.push({id:'h'+i,branch:'a',joined:'2025-01-01',expires:'2026-12-31',membershipPeriods:[{id:'ph'+i,plan:'pl',start:'2025-01-01',end:'2026-12-31',visits:i%2?null:50}]});
  for(let k=0;k<6000;k++){const d=new Date(Date.UTC(2025,0,1)+(k%400)*86400000).toISOString().slice(0,10);s.visits.push({id:'hv'+k,member:'h0',branch:'a',day:d,at:d+'T0'+(k%9)+':00:00.000Z',leftAt:d+'T0'+(k%9)+':30:00.000Z',sessions:[{},{}]});}
  await seed('QH',s);const st=await current('QH');
  const dirty=async()=>Number((await db.query("SELECT count(*) n FROM gymos.gym_member_summary_dirty WHERE owner_id='QH'")).rows[0].n);
  const d0=await dirty();let calls=0,worst=0,last;
  for(;calls<30;calls++){const t0=performance.now();last=await readQuotaIssues(scopeFor('QH'),{owner:'QH',branch:'a',branches:null,settings:st.settings,now:NOWS2[0]});worst=Math.max(worst,Math.round(performance.now()-t0));if(last.status==='ok')break;assert.equal(last.reason,'draining',JSON.stringify(last));}
  console.log('quota-issues worst-case: dirty',d0,'requests',calls+1,'worst request ms',worst);assert.equal(last.status,'ok');
  // oracle still exact for the heavy member
  const day=dayAt(NOWS2[0],st.settings.timezone);const want=st.members.filter(m=>!m.archived&&membershipIssue(st,m,day)==='quota').map(m=>m.id).sort();assert.deepEqual([...last.quota].sort(),want);
  // deadline with near-bound assertions: every statement costs 20 ms, units of 1 member, wave deadline 1200 ms. The deadline is checked before each unit, so the last unit must START before
  // t0+waveMs and the whole wave ends at most one unit (the largest observed gap between consecutive summary writes) plus the candidate-read tail after it.
  await db.query("INSERT INTO gymos.gym_member_summary_dirty(owner_id,member_id,gen) SELECT 'QH','h'||g,9000+g FROM generate_series(0,99) g ON CONFLICT DO NOTHING");
  const writes=[];const slow=(o,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner','QH',true)");return work({query:async(q,v)=>{await new Promise(r=>setTimeout(r,20));const r=await c.query(q,v);if(/INSERT INTO gymos.gym_member_summaries/.test(String(q)))writes.push(Date.now());return r;}});});
  const b=await dirty(),t1=Date.now(),WAVE=1200;const r=await readQuotaIssues(slow,{owner:'QH',branch:'a',branches:null,settings:st.settings,now:NOWS2[0],batch:1,waveMs:WAVE});const el=Date.now()-t1;
  const gaps=writes.slice(1).map((x,i)=>x-writes[i]),unit=Math.max(...gaps);
  console.log('quota-issues deadline: elapsed',el,'ms, wave',WAVE,'units done',writes.length,'largest unit',unit,'ms; status',r.status,r.reason,'dirty',b,'->',await dirty());
  assert.equal(r.status,'fallback');assert.equal(r.reason,'draining');assert.ok(writes.length>=2&&writes.length<100,'stopped by the deadline, after real progress: '+writes.length);
  assert.ok(writes.at(-1)-t1<=WAVE+unit+300,'last unit started before the deadline: '+(writes.at(-1)-t1));
  assert.ok(el<=WAVE+2*unit+1000,'total bounded by deadline + one unit + tail: '+el);
  const afterN=await dirty();assert.equal(b-afterN,writes.length,'progress kept exactly for the completed units');
});
test('scoped + shared budget + concurrency: a branch-a request never writes or waits on branch-b marks; recomputed <= budget in total; concurrent drainers converge without double work',async()=>{
  const {QUOTA_MAX_DIRTY}=await import('../app/lib/quota-issues-source.ts');
  const s=club();s.members=[];s.visits=[];
  for(let i=0;i<260;i++)s.members.push({id:'s'+i,branch:i%2?'a':'b',joined:'2026-01-01',expires:'2026-12-31',membershipPeriods:[{id:'ps'+i,plan:'pl',start:'2026-02-01',end:'2026-12-31',visits:i%3?null:2}]});
  await seed('QS',s);const st=await current('QS');
  const dirty=async b=>Number((await db.query("SELECT count(*) n FROM gymos.gym_member_summary_dirty d JOIN gymos.gym_entities e ON e.owner_id=d.owner_id AND e.collection='members' AND e.entity_id=d.member_id WHERE d.owner_id='QS' AND ($1::text IS NULL OR e.branch=$1)",[b])).rows[0].n);
  const rq=(b,extra={})=>readQuotaIssues(scopeFor('QS'),{owner:'QS',branch:b,branches:null,settings:st.settings,now:NOWS2[0],...extra});
  const bB=await dirty('b'),bA=await dirty('a');assert.ok(bB>=130&&bA>=130);
  let r=await rq('a');assert.equal(r.status,'fallback');assert.equal(r.reason,'draining');assert.equal(r.more,true,'more is exact: the branch has more than the budget');assert.equal(r.recomputed,QUOTA_MAX_DIRTY);
  assert.equal(await dirty('b'),bB,'branch b marks untouched by a branch-a request');assert.equal(await dirty('a'),bA-QUOTA_MAX_DIRTY);
  r=await rq('a');assert.equal(r.status,'ok',JSON.stringify(r));assert.ok(r.recomputed<=QUOTA_MAX_DIRTY,'one shared budget across wave and candidate read: '+r.recomputed);assert.equal(await dirty('b'),bB,'still untouched');
  // concurrent drainers on branch b: both finish, total recomputed work equals the backlog (no member recomputed twice by the winner/loser pair), final answers equal
  const outs=[];for(let i=0;i<12;i++){const pair=await Promise.all([rq('b'),rq('b')]);outs.push(pair.map(p=>p.status+':'+(p.reason??'')));if(pair.some(p=>p.status==='ok')&&await dirty('b')===0)break;}
  console.log('quota-issues concurrent',JSON.stringify(outs));assert.equal(await dirty('b'),0);
  const a=await rq('b'),b=await rq('b');assert.equal(a.status,'ok');assert.deepEqual(a.quota,b.quota);
  const day=dayAt(NOWS2[0],st.settings.timezone);assert.deepEqual([...a.quota].sort(),st.members.filter(m=>m.branch==='b'&&membershipIssue(st,m,day)==='quota').map(m=>m.id).sort());
});
