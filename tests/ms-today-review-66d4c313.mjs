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
let sd=777;const rnd=()=>{sd=(sd*1664525+1013904223)>>>0;return sd/2**32;};const pick=a=>a[Math.floor(rnd()*a.length)];
test('today-visits differential vs legacy expressions',async()=>{
  let cmp=0;
  for(let run=0;run<8;run++){
    const s=fixture();s.branches.push({id:'c',name:'C'});
    for(const m of s.members){m.branch=pick(['a','b','c']);if(rnd()<.2)m.demo=true;if(rnd()<.2)m.archived=true;m.name='N'+m.id;}
    s.visits=[];let n=0;const days=['2026-03-14','2026-03-15','2026-03-16'];
    for(let i=0;i<60;i++){const m=rnd()<.1?{id:'ghost'+i}:pick(s.members);const d=pick(days);s.visits.push({id:'z'+run+'v'+n++,member:m.id,branch:pick(['a','b','c']),day:d,at:d+'T10:00:00.000Z',leftAt:d+'T11:00:00.000Z'});}
    s.payments=[];s.invoices=[];
    const owner='T'+run;await seed(owner,s);const cur=await current(owner);
    const scope=(o,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);return work(c);});
    for(const branch of ['a','b','c'])for(const day of days){
      const members=cur.members.filter(m=>m.branch===branch&&!m.archived&&!m.demo);
      const count=cur.visits.filter(v=>v.branch===branch&&v.day===day&&members.some(m=>m.id===v.member)).length;
      const latest=cur.visits.filter(v=>v.branch===branch&&v.day===day).slice(-12).reverse();
      const nm=cur.members.filter(m=>m.branch===branch&&!m.archived);
      const out=await readTodayVisits(scope,{owner,branch,day});
      assert.equal(out.count,count,`count ${branch} ${day}`);
      assert.deepEqual(out.latest.map(x=>x.id),latest.map(v=>v.id),'latest ids');
      assert.deepEqual(out.latest.map(x=>x.name),latest.map(v=>nm.find(m=>m.id===v.member)?.name??null),'names');cmp++;}
    // cross owner: another owner sees nothing
    const o2=await readTodayVisits(scope,{owner:'nobody',branch:'a',day:days[0]});assert.equal(o2.count,0);assert.equal(o2.latest.length,0);
  }
  console.log('today comparisons',cmp);
});
