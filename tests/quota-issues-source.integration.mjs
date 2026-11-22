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
  assert.ok(seen.length<=8,'constant statement count, not per member: '+seen.length);
  // dirty budget: mark more than the budget dirty -> explicit fallback, nothing partial, no unbounded write-on-read
  await db.query("INSERT INTO gymos.gym_member_summary_dirty(owner_id,member_id,gen) SELECT 'QC','z'||g,1000+g FROM generate_series(0,$1) g ON CONFLICT DO NOTHING",[QUOTA_MAX_DIRTY*3]);
  const over=await readQuotaIssues(scopeFor('QC'),{owner:'QC',branch:'a',branches:null,settings:st.settings,now:NOWS2[0]});
  console.log('quota-issues over-budget',JSON.stringify(over));
  assert.equal(over.status,'fallback');
});
