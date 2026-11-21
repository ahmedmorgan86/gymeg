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

const {readDues,DUES_PAGE}=await import('../app/lib/dues-page.ts');
const {outstanding}=await import('../app/lib/extensions.ts');
let sd=99;const rnd=()=>{sd=(sd*1664525+1013904223)>>>0;return sd/2**32;};const pick=a=>a[Math.floor(rnd()*a.length)];
const scope=(o,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);return work(c);});
async function client(owner,q,between){ // same protocol as the hook: page 1 (+total), then pages with the version, restart on stale
  for(let attempt=0;attempt<3;attempt++){const d=await readDues(scope,{owner,...q});if(d.status!=='ok')throw new Error(d.status);
    let rows=[...d.rows],next=d.next,stale=false,pages=1;
    while(next){if(between&&pages===1&&attempt===0)await between();const pg=await readDues(scope,{owner,...q,after:next,ver:d.version});if(pg.status==='stale'){stale=true;break;}rows.push(...pg.rows);next=pg.next;pages++;}
    if(!stale)return{total:d.total,rows,pages};}
  throw new Error('restarts exhausted');}
test('dues == legacy outstanding list/total across pages, members, branches, odd allocations',async()=>{
  let cmp=0;
  for(let run=0;run<4;run++){
    const s=fixture();s.branches.push({id:'c',name:'C'});
    for(const m of s.members){m.branch=pick(['a','b','c']);if(rnd()<.2)m.archived=true;m.name='N'+m.id;}
    s.visits=[];s.payments=[];s.invoices=[];let pn=0,inum=0;
    for(const m of s.members)for(let k=0;k<1+Math.floor(rnd()*(run===0?3:25));k++){
      const b=rnd()<.9?m.branch:pick(['a','b','c']);const inv={id:'i'+inum++,member:m.id,title:'T'+inum,total:1000+Math.floor(rnd()*9000),due:'2026-03-1'+Math.floor(rnd()*9),branch:b,allocations:[],voided:rnd()<.1};
      for(let a=0;a<Math.floor(rnd()*3);a++){const bad=rnd()<.15;const pay={id:'p'+pn++,member:bad?pick(s.members).id:m.id,minor:100+Math.floor(rnd()*400),day:'2026-03-1'+a,method:pick(['cash','card']),voided:rnd()<.15,branch:bad?pick(['a','b']):b};s.payments.push(pay);inv.allocations.push({payment:rnd()<.05?'ghost'+pn:pay.id,minor:pay.minor});}
      s.invoices.push(inv);}
    const owner='D'+run;await seed(owner,s);const cur=await current(owner);
    const st={...cur,payments:cur.payments,invoices:cur.invoices};
    for(const branch of ['a','b','c'])for(const member of [undefined,pick(s.members).id]){
      const legacy=cur.invoices.filter(i=>i.branch===branch&&(!member||i.member===member));
      const out=await client(owner,{branch,...(member?{member}:{})});
      assert.equal(out.total,legacy.reduce((sum,i)=>sum+outstanding(st,i),0),'total '+branch);
      assert.deepEqual(out.rows.map(r=>r.invoice.id),legacy.map(i=>i.id),'order '+branch);
      assert.deepEqual(out.rows.map(r=>r.outstanding),legacy.map(i=>outstanding(st,i)),'row outstanding');
      const nm=cur.members.filter(m=>m.branch===branch&&!m.archived);
      assert.deepEqual(out.rows.map(r=>r.name),legacy.map(i=>nm.find(m=>m.id===i.member)?.name??null),'names');
      for(const [k,r] of out.rows.entries()){const i=legacy[k];assert.deepEqual(r.allocations.map(a=>[a.payment,a.day??undefined,a.method??undefined,a.voided??undefined]),i.allocations.map(a=>{const p=cur.payments.find(p=>p.id===a.payment);return[a.payment,p?.day,p?.method,p?.voided];}),'alloc detail');
        assert.deepEqual(r.allocations.map(a=>a.found&&!a.voided),i.allocations.map(a=>{const p=cur.payments.find(p=>p.id===a.payment);return Boolean(p)&&!p.voided;}),'void-guard input');}
      assert.ok(out.rows.length<=DUES_PAGE*out.pages);cmp++;}
    assert.equal((await readDues(scope,{owner:'nobody',branch:'a'})).status,'unavailable'==='x'?'':(await readDues(scope,{owner:'nobody',branch:'a'})).status);
  }
  console.log('dues comparisons',cmp);
});
test('writer between pages restarts to the post-write answer; stale not cached',async()=>{
  const s=fixture();s.visits=[];s.payments=[];s.invoices=[];for(let i=0;i<DUES_PAGE*3;i++)s.invoices.push({id:'z'+i,member:s.members[0].id,title:'t',total:1000,due:'2026-03-10',branch:s.members[0].branch,allocations:[],voided:false});
  await seed('DW',s);const br=s.members[0].branch;
  const out=await client('DW',{branch:br},async()=>{await db.query("DELETE FROM gymos.gym_entities WHERE owner_id='DW' AND collection='invoices' AND entity_id='z0'");});
  assert.equal(out.rows.length,DUES_PAGE*3-1);assert.ok(!out.rows.some(r=>r.invoice.id==='z0'));assert.equal(out.total,(DUES_PAGE*3-1)*1000);
  const o2=await readDues(scope,{owner:'nobody',branch:'a'});assert.ok(o2.status==='ok'||o2.status==='unavailable');
});

test('odd stored shapes are reported unavailable, never a quiet zero; maintained total equals legacy on clean data',async()=>{
  const owner='ODD';const s=fixture();await seed(owner,s);await refreshDirtySummaries(scope,owner).catch(()=>{});
  const br=s.invoices[0].branch;
  // clean: the maintained headline (when ready) or the scan equals the legacy total
  const clean=await readDues(scope,{owner,branch:br});assert.equal(clean.status,'ok');
  const legacy=s.invoices.filter(i=>i.branch===br).reduce((n,i)=>n+outstanding(s,i),0);assert.equal(clean.total,legacy);
  // odd: missing total, and a truthy non-boolean voided flag
  await db.query("UPDATE gymos.gym_entities SET payload=payload-'total' WHERE owner_id=$1 AND collection='invoices' AND entity_id=$2",[owner,s.invoices[0].id]);
  {const d=await readDues(scope,{owner,branch:br});assert.equal(d.status,'unavailable');assert.equal(d.reason,'invalid-data');assert.ok(d.invoices.includes(s.invoices[0].id));}
  await db.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{total}','100') WHERE owner_id=$1 AND collection='invoices' AND entity_id=$2",[owner,s.invoices[0].id]);
  await db.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{voided}','\"yes\"') WHERE owner_id=$1 AND collection='invoices' AND entity_id=$2",[owner,s.invoices[0].id]);
  assert.equal((await readDues(scope,{owner,branch:br})).status,'unavailable');
});

test('maintained total stays exact (no scan) after member deletion, orphan invoices, and writes between refreshes',async()=>{
  const {branchDuesTotal}=await import('../app/lib/member-summary-store.ts');
  const owner='ORP';const s=fixture();await seed(owner,s);
  await db.query("INSERT INTO gymos.gym_member_summary_ready(owner_id) VALUES($1) ON CONFLICT DO NOTHING",[owner]).catch(()=>{});
  const br=s.invoices[0].branch;
  const legacy=()=>current(owner).then(st=>st.invoices.filter(i=>i.branch===br).reduce((n,i)=>n+outstanding(st,i),0));
  const total=()=>scope(owner,c=>branchDuesTotal(c,owner,br));
  // cold: no summaries yet, dirty queue filled by backfill or empty; refresh waves bring it to the exact total
  assert.equal(await total(),await legacy());
  const victim=s.invoices.find(i=>i.branch===br).member;
  await db.query("DELETE FROM gymos.gym_entities WHERE owner_id=$1 AND collection='members' AND entity_id=$2",[owner,victim]);
  assert.equal(await total(),await legacy(),'orphan invoices of a deleted member still counted exactly');
  await db.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{total}','12345') WHERE owner_id=$1 AND collection='invoices' AND payload->>'member'=$2",[owner,victim]);
  assert.equal(await total(),await legacy(),'write to an orphan invoice');
  const other=s.invoices.find(i=>i.branch===br&&i.member!==victim);
  await db.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{total}','777') WHERE owner_id=$1 AND collection='invoices' AND entity_id=$2",[owner,other.id]);
  assert.equal(await total(),await legacy(),'write to a live member invoice');
});
