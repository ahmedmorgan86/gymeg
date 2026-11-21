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
const {readReportPayments,REPORT_PAGE}=await import('../app/lib/report-payments-page.ts');
const {paymentBreakdown}=await import('../app/lib/member-ledger.ts');
const scope=(o,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);return work(c);});
let sd=21;const rnd=()=>{sd=(sd*1664525+1013904223)>>>0;return sd/2**32;};const pick=a=>a[Math.floor(rnd()*a.length)];
async function pull(owner,q){let d=await readReportPayments(scope,{owner,...q}),rows=[...d.rows],pages=1;if(d.status!=='ok')throw new Error(JSON.stringify(d));while(d.next){const v=d.version;d=await readReportPayments(scope,{owner,...q,after:d.next,ver:v});assert.equal(d.status,'ok');rows.push(...d.rows);pages++;}return{rows,pages};}
test('report payment rows == legacy paymentBreakdown rows (all invoices scan) across pages, ranges and branch scopes',async()=>{
  const s=fixture();s.branches.push({id:'c',name:'C'});for(const m of s.members){m.branch=pick(['a','b','c']);m.name='N'+m.id;}
  s.visits=[];s.payments=[];s.invoices=[];let pn=0,inum=0;
  for(let k=0;k<REPORT_PAGE*2+41;k++){const m=pick(s.members),b=pick(['a','a','a','b','c']);
    s.payments.push({id:'p'+pn++,member:rnd()<.05?'ghost':m.id,branch:b,minor:100+Math.floor(rnd()*9000),day:'2026-03-'+String(1+Math.floor(rnd()*28)).padStart(2,'0'),method:pick(['cash','card']),voided:rnd()<.15,...(rnd()<.2?{category:'coaching'}:{}),...(rnd()<.2?{creditable:true}:{})});}
  for(let k=0;k<400;k++){const m=pick(s.members),allocs=[];for(let a=0;a<1+Math.floor(rnd()*3);a++){const p=pick(s.payments);allocs.push({payment:rnd()<.05?'nope':p.id,minor:50+Math.floor(rnd()*200)});}
    s.invoices.push({id:'i'+inum++,member:m.id,title:'T',total:5000,due:'2026-03-20',branch:pick(['a','b','c']),allocations:allocs,voided:rnd()<.1,...(rnd()<.3?{category:'coaching'}:{})});}
  await seed('R1',s);const cur=await current('R1');
  for(const [branches,visibleB] of [[null,['a','b','c']],[['a','b'],['a','b']]])for(const branch of ['a','b'])for(const [from,to] of [['2026-03-01','2026-03-31'],['2026-03-10','2026-03-12'],['2026-04-01','2026-04-30']]){
    const vis={...cur,invoices:cur.invoices.filter(i=>visibleB.includes(i.branch)),members:cur.members.filter(m=>visibleB.includes(m.branch))};
    const legacy=cur.payments.filter(p=>p.branch===branch&&p.day>=from&&p.day<=to).sort((x,y)=>x.day<y.day?-1:x.day>y.day?1:0); // server order differs; compared as sets keyed by id
    const out=await pull('R1',{branch,branches,from,to});
    assert.equal(out.rows.length,legacy.length);
    const byId=new Map(out.rows.map(r=>[r.payment.id,r]));
    for(const p of legacy){const r=byId.get(p.id);assert.ok(r,p.id);assert.deepEqual(r.breakdown,paymentBreakdown(vis,p),'breakdown '+p.id);
      assert.equal(r.name,vis.members.find(m=>m.id===p.member)?.name??null,'name');assert.equal(r.payment.method,p.method);assert.equal(r.payment.voided,p.voided);}
    assert.deepEqual(out.rows.map(r=>r.payment.day),out.rows.map(r=>r.payment.day).slice().sort());
    if(from==='2026-03-01'&&branch==='a')assert.ok(out.pages>1);
  }
  // stale after a write, odd data fails closed, bad input rejected
  const first=await readReportPayments(scope,{owner:'R1',branch:'a',from:'2026-03-01',to:'2026-03-31'});assert.ok(first.next);
  await db.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{method}','\"x\"') WHERE owner_id='R1' AND collection='payments' AND entity_id='p0'");
  assert.equal((await readReportPayments(scope,{owner:'R1',branch:'a',from:'2026-03-01',to:'2026-03-31',after:first.next,ver:first.version})).status,'stale');
  await assert.rejects(readReportPayments(scope,{owner:'R1',branch:'a',from:'x',to:'2026-03-31'}),RangeError);
  await db.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{day}','\"2026-3-1\"') WHERE owner_id='R1' AND collection='payments' AND entity_id='p1'");
  const b1=cur.payments.find(p=>p.id==='p1').branch;
  assert.deepEqual(await readReportPayments(scope,{owner:'R1',branch:b1,from:'2026-03-01',to:'2026-03-31'}),{status:'unavailable',reason:'non-canonical-day'});
});

test('bulk invoice: intermediate data per payment is only its own allocations; non-string member name refused; duplicate payload payment ids across branches match legacy',async()=>{
  const s=fixture();s.visits=[];s.payments=[];s.invoices=[];const [m1,m2]=s.members;m1.branch='a';m2.branch='b';m1.name='N1';m2.name='N2';
  for(let k=0;k<3000;k++)s.payments.push({id:'q'+k,member:m1.id,branch:'a',minor:1000,day:'2026-03-05',method:'cash',voided:false});
  // two payments in different branches share the same payload id 'dup' (entity ids differ)
  s.payments.push({id:'dup',member:m1.id,branch:'a',minor:700,day:'2026-03-06',method:'cash',voided:false});
  s.invoices.push({id:'bulk',member:m1.id,title:'T',total:9e6,due:'2026-03-20',branch:'a',allocations:[...s.payments.slice(0,3000).map(p=>({payment:p.id,minor:10,note:'x'.repeat(200)})),{payment:'dup',minor:25,note:'y'}],category:'coaching',voided:false});
  s.invoices.push({id:'other',member:m2.id,title:'T',total:100,due:'2026-03-20',branch:'b',allocations:[{payment:'dup',minor:5}],category:'coaching',voided:false});
  await seed('B1',s);
  // entity ids are unique per owner but a payload id can repeat across rows/branches (legacy matches by payload id only): add a second row with payload id 'dup' in branch b
  await db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES('B1','payments','dup-b',99999,'b',$1)",[JSON.stringify({id:'dup',member:m2.id,branch:'b',minor:900,day:'2026-03-06',method:'card',voided:false})]);
  const cur=await current('B1');
  let maxLen=0;const spy=(o,work)=>scope(o,c=>work({query:async(sql,v)=>{const r=await c.query(sql,v);if(/jsonb_object_agg/.test(sql))for(const row of r.rows)maxLen=Math.max(maxLen,JSON.stringify(row).length);return r;}}));
  const full={...cur};
  for(const branch of ['a','b']){
    const r=await readReportPayments(spy,{owner:'B1',branch,branches:null,from:'2026-03-01',to:'2026-03-31'});assert.equal(r.status,'ok');
    for(const x of r.rows){const p=cur.payments.find(p=>p.id===x.payment.id&&p.branch===branch&&p.member===x.payment.member);assert.deepEqual(x.breakdown,paymentBreakdown(full,p),x.payment.id+branch);}
  }
  { // branch-limited caller: legacy runs over ITS packet (invoices of its branches only), so a branch-b invoice never reaches a branch-a row
    const lim={...cur,invoices:cur.invoices.filter(i=>i.branch==='a')};
    const r=await readReportPayments(scope,{owner:'B1',branch:'a',branches:['a'],from:'2026-03-01',to:'2026-03-31'});assert.equal(r.status,'ok');
    for(const x of r.rows){const p=cur.payments.find(p=>p.id===x.payment.id&&p.branch==='a'&&p.member===x.payment.member);assert.deepEqual(x.breakdown,paymentBreakdown(lim,p),'restricted '+x.payment.id);}
    const day6=async b=>(await readReportPayments(scope,{owner:'B1',branch:'a',branches:b,from:'2026-03-06',to:'2026-03-06'})).rows.find(x=>x.payment.id==='dup');
    const dup=await day6(['a']),full2=await day6(null);assert.ok(dup&&full2);
    assert.deepEqual(dup.breakdown,paymentBreakdown(lim,cur.payments.find(p=>p.id==='dup'&&p.branch==='a')));
    assert.notDeepEqual(dup.breakdown,full2.breakdown);
  }
  assert.ok(maxLen>0&&maxLen<150000,'candidate row carries only the page payments allocations (no notes): '+maxLen); // the bulk invoice payload is ~700KB with 200-char notes; elements are reduced to {payment,minor}
  await db.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{name}','5') WHERE owner_id='B1' AND collection='members' AND entity_id=$1".replace('$1',"'"+m1.id+"'"));
  assert.deepEqual(await readReportPayments(scope,{owner:'B1',branch:'a',branches:null,from:'2026-03-01',to:'2026-03-31'}),{status:'unavailable',reason:'member-name'});
  await db.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{name}','null') WHERE owner_id='B1' AND collection='members' AND entity_id=$1".replace('$1',"'"+m1.id+"'"));
  assert.equal((await readReportPayments(scope,{owner:'B1',branch:'a',branches:null,from:'2026-03-01',to:'2026-03-31'})).rows[0].name,null);
});
