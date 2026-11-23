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

const fixBranch=o=>db.query("UPDATE gymos.gym_member_summary_dirty d SET branch=e.branch FROM gymos.gym_entities e WHERE d.owner_id=$1 AND d.branch IS NULL AND e.owner_id=d.owner_id AND e.collection='members' AND e.entity_id=d.member_id",[o]);
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
  await db.query("INSERT INTO gymos.gym_member_summary_dirty(owner_id,member_id,gen) SELECT 'QC','z'||g,1000+g FROM generate_series(0,$1) g ON CONFLICT DO NOTHING",[QUOTA_MAX_DIRTY*3]);await fixBranch('QC');
  // convergence: each request drains at most the budget and says so; repeated reads reach ok with no request exceeding the budget
  let calls=0,last,peak=0;const dirtyN=async()=>Number((await db.query("SELECT count(*) n FROM gymos.gym_member_summary_dirty WHERE owner_id='QC'")).rows[0].n);
  const d0=await dirtyN();
  for(;calls<20;calls++){const before=await dirtyN();last=await readQuotaIssues(scopeFor('QC'),{owner:'QC',branch:'a',branches:null,settings:st.settings,now:NOWS2[0]});peak=Math.max(peak,before-await dirtyN());if(last.status==='ok')break;assert.deepEqual([last.status,last.reason],['fallback','draining']);}
  console.log('quota-issues drain: dirty',d0,'requests until ok',calls+1,'max recomputed per request',peak);
  assert.equal(last.status,'ok');assert.ok(peak<=QUOTA_MAX_DIRTY&&calls>=1);
  // forced failure mid-wave: the transaction rolls back (marks and summaries unchanged) and the connection is usable afterwards
  await db.query("INSERT INTO gymos.gym_member_summary_dirty(owner_id,member_id,gen) SELECT 'QC','z'||g,5000+g FROM generate_series(0,60) g ON CONFLICT DO NOTHING");await fixBranch('QC');
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
  await db.query("INSERT INTO gymos.gym_member_summary_dirty(owner_id,member_id,gen) SELECT 'QH','h'||g,9000+g FROM generate_series(0,99) g ON CONFLICT DO NOTHING");await fixBranch('QH');
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
test('branch-scoped marks: every writer path carries the member branch; moves rewrite it; orphans carry the causing row branch and drain; NULL-branch and foreign-branch marks never block a request; unmarked missing/old summaries drain too',async()=>{
  const s=club();s.visits=[];s.members=s.members.slice(0,9);await seed('QB',s);const st=await current('QB');
  for(let i=0;i<20;i++){const r=await db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner','QB',true)");return refreshDirtySummaries(c,'QB',500,AS);});if(!r.remaining)break;}
  const marks=async()=>Object.fromEntries((await db.query("SELECT member_id,branch,gen FROM gymos.gym_member_summary_dirty WHERE owner_id='QB'")).rows.map(r=>[r.member_id,r.branch]));
  const mem=(await db.query("SELECT entity_id,branch FROM gymos.gym_entities WHERE owner_id='QB' AND collection='members' ORDER BY position LIMIT 3")).rows;
  const ins=(id,m,b)=>db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES('QB','visits',$1,$2,$3,$4)",[id,50000+Math.floor(rnd()*1e6),b,JSON.stringify({id,member:m,branch:b,day:'2026-03-02',at:'2026-03-02T09:00:00.000Z',leftAt:'2026-03-02T09:30:00.000Z'})]);
  // a cross-branch visit marks the MEMBER's branch, not the visit's
  const other=['a','b','c'].find(b=>b!==mem[0].branch);await ins('xv',mem[0].entity_id,other);let m=await marks();assert.equal(m[mem[0].entity_id],mem[0].branch,'member branch, not the visit branch');
  // a move rewrites the mark branch through the update trigger
  await db.query("UPDATE gymos.gym_entities SET branch=$1,payload=jsonb_set(payload,'{branch}',to_jsonb($1::text)) WHERE owner_id='QB' AND collection='members' AND entity_id=$2",[other,mem[1].entity_id]);m=await marks();assert.equal(m[mem[1].entity_id],other,'moved member: mark follows');
  // orphans: a visit and an invoice of a member without a row take the causing row's branch; a member row deletion keeps its mark with the old branch
  await ins('ov','ghost1','a');await db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES('QB','invoices','gi1',77777,'a','{\"id\":\"gi1\",\"member\":\"ghost2\",\"branch\":\"a\",\"total\":500,\"allocations\":[]}')");
  await db.query("DELETE FROM gymos.gym_entities WHERE owner_id='QB' AND collection='members' AND entity_id=$1",[mem[2].entity_id]);
  m=await marks();assert.equal(m.ghost1,'a');assert.equal(m.ghost2,'a');assert.equal(m[mem[2].entity_id],mem[2].branch,'deleted member: mark kept with its last branch');
  // foreign-branch and NULL-branch marks never block a branch request
  await db.query("INSERT INTO gymos.gym_member_summary_dirty(owner_id,member_id,gen,branch) VALUES('QB','nullbranch',99999,NULL),('QB','foreign',99998,'zzz')");
  const rq=b=>readQuotaIssues(scopeFor('QB'),{owner:'QB',branch:b,branches:null,settings:st.settings,now:NOWS2[0]});
  const deleted=mem[2].branch;let seen=[];
  for(const b of ['a','b','c']){let r;for(let i=0;i<5;i++){r=await rq(b);seen.push(b+':'+r.status);if(r.status==='ok')break;}assert.equal(r.status,'ok',b+' '+JSON.stringify(r));}
  assert.equal((await marks()).ghost1,undefined,'orphan visit mark drained by its branch request');assert.equal((await marks()).ghost2,undefined);
  assert.ok('nullbranch' in await marks()&&'foreign' in await marks(),'NULL-branch and foreign-branch marks untouched');
  // unmarked missing summary and an old-version row: the same wave computes them (never stuck on stale)
  const victim=(await db.query("SELECT entity_id,branch FROM gymos.gym_entities WHERE owner_id='QB' AND collection='members' LIMIT 2")).rows;
  await db.query("DELETE FROM gymos.gym_member_summaries WHERE owner_id='QB' AND member_id=$1",[victim[0].entity_id]);
  await db.query("UPDATE gymos.gym_member_summaries SET stored=jsonb_set(stored,'{v}','1') WHERE owner_id='QB' AND member_id=$1",[victim[1].entity_id]);
  assert.equal((await marks())[victim[0].entity_id],undefined,'not marked');
  for(const v of victim){let r;for(let i=0;i<4;i++){r=await rq(v.branch);if(r.status==='ok')break;}assert.equal(r.status,'ok',JSON.stringify(r));}
  const rows=(await db.query("SELECT member_id,stored->>'v' v,branch FROM gymos.gym_member_summaries WHERE owner_id='QB' AND member_id=ANY($1)",[victim.map(v=>v.entity_id)])).rows;assert.deepEqual(rows.map(r=>r.v),['2','2']);assert.ok(rows.every(r=>r.branch));
  console.log('quota-issues branch marks',JSON.stringify(seen));
});
test('P1: a LIVE member with a v2 summary and a NULL-branch or wrong-branch mark is never trusted as ok; the wave drains it; lazy migration of NULL-branch summaries/marks converges; legacy NULL orphans drain owner-wide',async()=>{
  const s=club();s.visits=[];s.members=s.members.slice(0,12);await seed('QP',s);const st=await current('QP');
  for(let i=0;i<20;i++){const r=await db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner','QP',true)");return refreshDirtySummaries(c,'QP',500,AS);});if(!r.remaining)break;}
  const rq=b=>readQuotaIssues(scopeFor('QP'),{owner:'QP',branch:b,branches:null,settings:st.settings,now:NOWS2[0]});
  for(const b of ['a','b','c'])assert.equal((await rq(b)).status,'ok');
  const live=(await db.query("SELECT entity_id,branch FROM gymos.gym_entities WHERE owner_id='QP' AND collection='members' ORDER BY position LIMIT 3")).rows;
  // a visit written while the member is capped changes the truth; the mark is then corrupted to NULL / foreign branch (as a pre-migration or direct-SQL row would be)
  const stored=async id=>(await db.query("SELECT stored FROM gymos.gym_member_summaries WHERE owner_id='QP' AND member_id=$1",[id])).rows[0].stored;
  const before=await Promise.all(live.map(m=>stored(m.entity_id)));
  for(const [i,m] of live.entries()){await db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES('QP','visits',$1,$2,$3,$4)",['pv'+i,60000+i,m.branch,JSON.stringify({id:'pv'+i,member:m.entity_id,branch:m.branch,day:'2026-03-02',at:'2026-03-02T09:00:00.000Z',leftAt:'2026-03-02T09:30:00.000Z'})]);}
  await db.query("UPDATE gymos.gym_member_summary_dirty SET branch=NULL WHERE owner_id='QP' AND member_id=$1",[live[0].entity_id]);
  await db.query("UPDATE gymos.gym_member_summary_dirty SET branch='zzz' WHERE owner_id='QP' AND member_id=$1",[live[1].entity_id]);
  // candidate read alone (no refresh) must see them as stale, not ok
  for(const m of live.slice(0,2)){const r=await db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner','QP',true)");return readMemberCandidates(c,'QP',[m.branch],{refresh:false,now:NOWS2[0],photo:false});});assert.equal(r.status,'stale','dirty live member with a bad-branch mark is stale: '+m.entity_id);}
  // the quota request drains it (branch-bounded selection includes live members whose mark branch differs) and the answer equals the legacy oracle
  const sNow=await current('QP');const day=dayAt(NOWS2[0],sNow.settings.timezone);
  for(const b of ['a','b','c']){let r;for(let i=0;i<5;i++){r=await rq(b);if(r.status==='ok')break;}assert.equal(r.status,'ok',b+JSON.stringify(r));assert.deepEqual([...r.quota].sort(),sNow.members.filter(m=>m.branch===b&&!m.archived&&membershipIssue(sNow,m,day)==='quota').map(m=>m.id).sort());}
  const after=await Promise.all(live.map(m=>stored(m.entity_id)));assert.ok(after.some((x,i)=>JSON.stringify(x)!==JSON.stringify(before[i])),'summaries were recomputed');
  assert.equal(Number((await db.query("SELECT count(*) n FROM gymos.gym_member_summary_dirty WHERE owner_id='QP' AND member_id=ANY($1)",[live.map(m=>m.entity_id)])).rows[0].n),0,'marks cleared');
  // lazy migration: every summary and mark has NULL branch (pre-migration rows): the request converges to ok and writes the branches
  await db.query("UPDATE gymos.gym_member_summaries SET branch=NULL WHERE owner_id='QP'");
  await db.query("INSERT INTO gymos.gym_member_summary_dirty(owner_id,member_id,gen,branch) SELECT owner_id,entity_id,nextval('gymos.member_summary_gen'),NULL FROM gymos.gym_entities WHERE owner_id='QP' AND collection='members' ON CONFLICT(owner_id,member_id) DO UPDATE SET branch=NULL");
  for(const b of ['a','b','c']){let r;for(let i=0;i<6;i++){r=await rq(b);if(r.status==='ok')break;}assert.equal(r.status,'ok','lazy '+b+JSON.stringify(r));}
  assert.equal(Number((await db.query("SELECT count(*) n FROM gymos.gym_member_summaries WHERE owner_id='QP' AND branch IS NULL AND (stored->>'v')::int<>0")).rows[0].n),0,'branches written lazily');
  // legacy NULL-branch orphan marks: never block a branch request, drained by the owner-wide refresher
  await db.query("INSERT INTO gymos.gym_member_summary_dirty(owner_id,member_id,gen,branch) VALUES('QP','legacy-ghost',123456,NULL)");
  assert.equal((await rq('a')).status,'ok','NULL-branch orphan does not block');
  const w=await db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner','QP',true)");return refreshDirtySummaries(c,'QP',500,AS);});assert.equal(w.remaining,0);
  assert.equal(Number((await db.query("SELECT count(*) n FROM gymos.gym_member_summary_dirty WHERE owner_id='QP' AND member_id='legacy-ghost'")).rows[0].n),0,'owner-wide refresher drained it');
});
test('steady state: a clean request never runs the branch anti-join (repair arm); a missing or unstamped summary triggers exactly the repair wave and converges',async()=>{
  const s=club();s.visits=[];await seed('QX',s);const st=await current('QX');const sqls=[];
  const spy=(o,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner','QX',true)");return work({query:(q,v)=>{sqls.push(String(q));return c.query(q,v);}});});
  const rq=(b,sc=spy)=>readQuotaIssues(sc,{owner:'QX',branch:b,branches:null,settings:st.settings,now:NOWS2[0]});
  for(let i=0;i<20;i++){const r=await db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner','QX',true)");return refreshDirtySummaries(c,'QX',500,AS);});if(!r.remaining)break;}
  for(let i=0;i<5;i++){const r=await rq('a');if(r.status==='ok')break;}
  sqls.length=0;const clean=await rq('a');assert.equal(clean.status,'ok');assert.equal(clean.recomputed,0);
  const anti=q=>/LEFT JOIN gymos\.gym_member_summaries s ON s\.owner_id=e\.owner_id AND s\.member_id=e\.entity_id AND s\.branch=\$3/.test(q);
  assert.equal(sqls.filter(anti).length,0,'no anti-join on a clean request');
  // a summary row that vanished (never computed) -> candidate read sees it missing -> exactly one repair selection, then ok
  const gone=(await db.query("SELECT entity_id FROM gymos.gym_entities WHERE owner_id='QX' AND collection='members' AND branch='a' AND payload->>'archived' IS NULL LIMIT 2")).rows.map(r=>r.entity_id);
  await db.query("DELETE FROM gymos.gym_member_summaries WHERE owner_id='QX' AND member_id=ANY($1)",[gone]);
  sqls.length=0;let r=await rq('a');for(let i=0;i<4&&r.status!=='ok';i++){r=await rq('a');}assert.equal(r.status,'ok',JSON.stringify(r));
  assert.ok(sqls.filter(anti).length>=1,'repair arm ran when needed');
  sqls.length=0;const again=await rq('a');assert.equal(again.status,'ok');assert.equal(again.recomputed,0);assert.equal(sqls.filter(anti).length,0,'and not again once converged');
  // unstamped (NULL-branch) summaries only (v2 and clean): found missing by the branch-scoped read, repaired within the budget
  await db.query("UPDATE gymos.gym_member_summaries SET branch=NULL WHERE owner_id='QX'");
  let q=await rq('b');for(let i=0;i<4&&q.status!=='ok';i++){q=await rq('b');}assert.equal(q.status,'ok',JSON.stringify(q));
});
test('remote-shaped schema: each missing prerequisite table yields a typed fallback/unready, never a thrown query error',async()=>{
  const s=club();s.visits=[];await seed('QM',s);const st=await current('QM');
  const cases=[['gym_member_summaries'],['gym_member_summary_ready'],['gym_entity_counters'],['gym_owner_version'],['gym_member_summaries','gym_member_summary_ready','gym_entity_counters','gym_owner_version']];
  for(const drop of cases){
    const out=await db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner','QM',true)");
      for(const t of drop)await c.query(`DROP TABLE IF EXISTS gymos.${t} CASCADE`);
      const cand=await readMemberCandidates(c,'QM',null,{refresh:false,now:AS});
      let q;try{q=await readQuotaIssues((o,work)=>work(c),{owner:'QM',branch:'a',branches:null,settings:st.settings,now:NOWS2[0]});}catch(e){q={threw:String(e.message)};}
      throw Object.assign(new Error('ROLLBACK_PROBE'),{probe:{cand,q}});}).then(()=>({txError:'no rollback'}),e=>e.probe?e.probe:({txError:String(e.message)}));
    assert.ok(!out.txError,'transaction aborted for drop '+drop.join(',')+': '+out.txError);
    assert.ok(!out.q?.threw,'readQuotaIssues threw for drop '+drop.join(',')+': '+out.q?.threw);
    assert.notEqual(out.q.status,'ok','must not claim ok without its tables: '+drop.join(','));
    assert.ok(['fallback','unchanged'].includes(out.q.status),drop.join(',')+' -> '+out.q.status);
    await db.query('SELECT 1');
  }
});
test('actual route code + the real client drain policy: a backlog needing more than 25 requests stops at the 25 cap with a fallback (never a partial ok); a backlog within the cap converges to ok',async()=>{
  const {drainDecision,DRAIN_MAX_ATTEMPTS}=await import('../app/use-quota-issues.ts');
  const {QUOTA_MAX_DIRTY}=await import('../app/lib/quota-issues-source.ts');
  const s=club();s.visits=[];await seed('QZ',s);const st=await current('QZ');
  const mark=n=>db.query("INSERT INTO gymos.gym_member_summary_dirty(owner_id,member_id,gen,branch) SELECT 'QZ','zz'||g,5000+g,'a' FROM generate_series(1,$1) g ON CONFLICT DO NOTHING",[n]);
  const dirtyN=async()=>Number((await db.query("SELECT count(*) n FROM gymos.gym_member_summary_dirty WHERE owner_id='QZ' AND branch='a'")).rows[0].n);
  const follow=async()=>{let n=0,zero=0,last;for(;;){last=await readQuotaIssues(scopeFor('QZ'),{owner:'QZ',branch:'a',branches:null,settings:st.settings,now:NOWS2[0]});n++;if(last.status==='ok')return{n,last,stopped:false};if(last.reason==='draining')zero=last.recomputed>0?0:zero+1;if(drainDecision(last,n,zero)!=='retry')return{n,last,stopped:true};}};
  await mark(QUOTA_MAX_DIRTY*(DRAIN_MAX_ATTEMPTS+2));const before=await dirtyN();
  const over=await follow();console.log('25-cap over-budget: dirty',before,'requests',over.n,'status',over.last.status,over.last.reason??'','remaining',await dirtyN());
  assert.equal(over.n,DRAIN_MAX_ATTEMPTS,'client stops exactly at the cap');assert.equal(over.stopped,true);assert.equal(over.last.status,'fallback');assert.ok(await dirtyN()>0,'work remains, nothing claimed done');
  const again=await follow();console.log('after Retry: requests',again.n,again.last.status);assert.equal(again.last.status,'ok');assert.ok(again.n<=DRAIN_MAX_ATTEMPTS);
});
