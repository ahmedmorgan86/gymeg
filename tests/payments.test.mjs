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
const {readPaymentsSummary,readPaymentsExport,PAYMENTS_PAGE}=await import('../app/lib/payments-page.ts');
const {addDays}=await import('../app/lib/domain.ts');
const scope=(o,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);return work(c);});
let sd=7;const rnd=()=>{sd=(sd*1664525+1013904223)>>>0;return sd/2**32;};const pick=a=>a[Math.floor(rnd()*a.length)];
async function exportAll(owner,branch){let d=await readPaymentsExport(scope,{owner,branch}),rows=[...d.rows],pages=1;while(d.next){const v=d.version;d=await readPaymentsExport(scope,{owner,branch,after:d.next,ver:v});assert.equal(d.status,'ok');rows.push(...d.rows);pages++;}return{rows,pages};}
test('payments summary/trend/export == legacy expressions, paging, odd data, stale',async()=>{
  const TODAY='2026-03-14';
  const s=fixture();s.branches.push({id:'c',name:'C'});for(const m of s.members){m.branch=pick(['a','b','c']);if(rnd()<.2)m.archived=true;m.name='N'+m.id;}
  s.visits=[];s.invoices=[];s.payments=[];
  for(let n=0;n<PAYMENTS_PAGE*2+37;n++){const m=pick(s.members);s.payments.push({id:'p'+n,member:rnd()<.05?'ghost':m.id,branch:pick(['a','a','a','b','c']),minor:Math.floor(rnd()*100000)+1,day:addDays(TODAY,-Math.floor(rnd()*70)+3),method:pick(['cash','card']),voided:rnd()<.2});}
  await seed('P1',s);const cur=await current('P1');
  for(const branch of ['a','b','c'])for(const period of [7,30,60]){
    const pays=cur.payments.filter(p=>p.branch===branch),r=await readPaymentsSummary(scope,{owner:'P1',branch,today:TODAY,period});assert.equal(r.status,'ok');
    assert.deepEqual(r.trend,Array.from({length:period},(_,i)=>{const day=addDays(TODAY,i-period+1);return pays.filter(p=>!p.voided&&p.day===day).reduce((v,p)=>v+p.minor/100,0);}),'trend '+branch+period);
    assert.equal(r.monthSum,pays.filter(p=>!p.voided&&p.day.startsWith(TODAY.slice(0,7))).reduce((a,p)=>a+p.minor,0),'month '+branch);
  }
  for(const branch of ['a','b','c']){
    const pays=cur.payments.filter(p=>p.branch===branch),mem=cur.members.filter(m=>m.branch===branch),out=await exportAll('P1',branch);
    assert.deepEqual(out.rows.map(r=>r.payment.id),pays.map(p=>p.id),'export order '+branch);
    assert.deepEqual(out.rows.map(r=>[r.member?.name??null,r.member?.demo??null]),pays.map(p=>[mem.find(m=>m.id===p.member)?.name??null,mem.find(m=>m.id===p.member)?.demo??null]),'export names');
    if(pays.length>PAYMENTS_PAGE)assert.ok(out.pages>1);
  }
  // stale: a write between pages
  const d=await readPaymentsExport(scope,{owner:'P1',branch:'a'});assert.ok(d.next);
  await db.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{method}','\"x\"') WHERE owner_id='P1' AND collection='payments' AND entity_id='p0'");
  const st=await readPaymentsExport(scope,{owner:'P1',branch:'a',after:d.next,ver:d.version});assert.equal(st.status,'stale');
  // odd data fails closed
  await db.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{minor}','\"12\"') WHERE owner_id='P1' AND collection='payments' AND entity_id='p0'");
  const bad=cur.payments.find(p=>p.id==='p0').branch;const o=await readPaymentsSummary(scope,{owner:'P1',branch:bad,today:TODAY,period:7});
  assert.ok(o.status==='unavailable'||o.status==='ok'&&false,'odd minor'+JSON.stringify(o).slice(0,80));
  await assert.rejects(readPaymentsSummary(scope,{owner:'P1',branch:'a',today:'x',period:7}),RangeError);
  await assert.rejects(readPaymentsSummary(scope,{owner:'P1',branch:'a',today:TODAY,period:0}),RangeError);
});
