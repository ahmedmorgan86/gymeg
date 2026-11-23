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
const {readMemberDetail}=await import('../app/lib/member-detail-source.ts');
let seedn=12345;const rnd=()=>{seedn=(seedn*1664525+1013904223)>>>0;return seedn/2**32;};const pick=a=>a[Math.floor(rnd()*a.length)];
const NOWS2=['2026-03-15T12:00:00.000Z','2026-03-15T22:30:00.000Z','2026-03-20T22:30:00.000Z','2026-04-01T00:30:00.000Z','2027-01-02T10:00:00.000Z'];
test('random multi-branch detail differential vs memberSummary(packet-filtered state)',async()=>{
  let cmp=0;
  for(let run=0;run<6;run++){
    const s=fixture();s.branches.push({id:'c',name:'C'});
    for(const m of s.members)if(rnd()<.3)m.branch=pick(['a','b','c']);
    const B=['a','b','c'];let n=0;
    s.visits=[];s.payments=[];s.invoices=[];
    for(const m of s.members){const per=(m.membershipPeriods??[]).map(p=>p.id);
      for(let i=0;i<Math.floor(rnd()*14);i++){const d=pick(['2025-06-01','2026-02-10','2026-03-01','2026-03-05','2026-03-12','2026-03-13','2026-03-14','2026-03-15','2026-03-18']);const open=rnd()<.1&&d>='2026-03-14';
        s.visits.push({id:'x'+run+'v'+n++,member:m.id,branch:pick(B),day:d,at:d+'T'+pick(['08','10','13'])+':00:00.000Z',...(open?{}:{leftAt:d+'T22:00:00.000Z'}),...(rnd()<.3&&per.length?{periodId:pick(per)}:{}),...(rnd()<.2?{sessions:[{},{}]}:{})});}
      for(let i=0;i<Math.floor(rnd()*3);i++){const pid='x'+run+'p'+n++;s.payments.push({id:pid,member:m.id,branch:pick(B),minor:Math.floor(rnd()*500)+1,day:'2026-03-02',voided:rnd()<.15});
        if(rnd()<.7)s.invoices.push({id:'x'+run+'i'+n++,member:m.id,branch:pick(B),total:Math.floor(rnd()*900)+100,due:'2026-03-01',voided:rnd()<.15,allocations:rnd()<.6?[{payment:pid,minor:50}]:[]});}}
    // one open visit per member max
    const seen=new Set();for(const v of s.visits)if(!v.leftAt){if(seen.has(v.member))v.leftAt=v.day+'T23:00:00.000Z';seen.add(v.member);}
    const owner='R'+run;await seed(owner,s);const cur=await current(owner);
    const scope=(o,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);return work(c);});
    for(const br of [null,['a','b'],['a'],['c']]){
      const vis=x=>!br||br.includes(x.branch);
      const pk={...cur,members:cur.members.filter(vis),visits:cur.visits.filter(vis),payments:cur.payments.filter(vis),invoices:(cur.invoices??[]).filter(vis)};
      for(const m of cur.members){
        const out=await readMemberDetail(scope,{owner,member:m.id,branches:br,financial:true,settings:cur.settings,asOf:AS});
        if(!vis(m)){assert.equal(out.status,'notFound',m.id+' outside scope');continue;}
        assert.equal(out.status,'ok');
        for(const now of NOWS2){const want=memberSummary(pk,m,now),got=deriveSummary(strip(out.stored),m,cur.settings,now);assert.ok(got,'derive null');
          for(const k of ['period','issue','remaining','debt','status','used','visitsRemaining','paid'])assert.deepEqual(strip(got[k]),strip(want[k]),`run${run} br=${br} ${m.id} @${now}: ${k}`);
          assert.equal(got.current?.id,want.current?.id,'current '+m.id);assert.equal(got.last?.id,want.last?.id,'last '+m.id);cmp++;}
        assert.equal(out.stored.visitCount,pk.visits.filter(v=>v.member===m.id).length,'visitCount');
        assert.deepEqual(strip(out.invoices),strip(memberSummary(pk,m,NOWS2[0]).invoices),'invoices');
        assert.deepEqual(strip(out.payments),strip(pk.payments.filter(p=>p.member===m.id)),'payments');
      }}
  }
  console.log('detail comparisons',cmp);
});
