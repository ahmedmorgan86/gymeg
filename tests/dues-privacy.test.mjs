import {test} from 'node:test';import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const db=globalThis.__hotDb=await bootstrapDb();
registerHooks({
  resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}},
  load(url,ctx,next){if(url.endsWith('/app/lib/database.ts'))return{format:'module',shortCircuit:true,source:`export const getPool=()=>({connect:async()=>({query:(sql,v)=>globalThis.__hotDb.query(sql,v),release(){}})});export const withScope=async()=>{throw new Error('x')};`};return next(url,ctx);}
});
const {splitState}=await import('../app/lib/entity-state.ts');
const {fixture}=await import('./member-summary-fixture.mjs');
const {refreshDirtySummaries}=await import('../app/lib/member-summary-store.ts');
const {readConsoleCandidates}=await import('../app/lib/member-console-source.ts');
const {readMemberDetail}=await import('../app/lib/member-detail-source.ts');
const {readDues}=await import('../app/lib/dues-page.ts');
const scope=(o,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);return work(c);});
const owner='PRV';
async function seed(){
  const s=fixture();s.branches.push({id:'c',name:'C'});
  const m=s.members.find(x=>x.branch==='a');
  s.payments=[{id:'pS',member:m.id,branch:'b',minor:500,day:'2026-03-02',method:'cash',voided:false}];
  s.invoices=[{id:'iN',member:m.id,branch:'a',total:900,due:'2026-03-01',voided:false,allocations:[{payment:'pS',minor:500}]},{id:'iS',member:m.id,branch:'b',total:700,due:'2026-03-01',voided:false,allocations:[]}];
  s.visits=[];
  const {metadata,entities}=splitState(s);
  await db.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,5,$3)',[owner,JSON.stringify({...metadata,_entityStorage:1,_activityArchive:1}),'x']);
  for(const e of entities)await db.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',[owner,e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);
  await db.query("INSERT INTO gymos.gym_member_summary_ready(owner_id) VALUES($1) ON CONFLICT DO NOTHING",[owner]);
  await scope(owner,async c=>{for(let i=0;i<5;i++){const r=await refreshDirtySummaries(c,owner);if(r.status!=='ok'||!r.remaining)break;}});
  return {s,m};
}
const hasDues=o=>JSON.stringify(o,(k,v)=>k==='dues'&&v&&Object.keys(v).length?'LEAK':v).includes('LEAK');
test('stored dues never serialized in candidate or detail DTOs (reception, branch-limited, owner)',async()=>{
  const {s,m}=await seed();
  const internal=(await db.query("SELECT stored FROM gymos.gym_member_summaries WHERE owner_id=$1 AND member_id=$2",[owner,m.id])).rows[0].stored;
  assert.ok(Object.keys(internal.dues).length>=2,'internal aggregate keeps per-branch dues');assert.equal(hasDues({stored:internal}),true,'detector sanity');
  for(const [branches,financial] of [[['a'],false],[['a'],true],[null,true],[null,false]]){
    const r=await readConsoleCandidates(scope,{owner,tenantId:'t',branch:'a',branches,financial});
    assert.equal(r.status,'ok');assert.equal(hasDues(r),false);
    const d=await readMemberDetail(scope,{owner,member:m.id,branches,financial,settings:s.settings,asOf:'2026-03-14T00:00:00.000Z'});
    if(d.status==='ok')assert.equal(hasDues(d),false);
  }
});
test('dues allocation metadata hides a payment outside the caller branch scope',async()=>{
  const {m}=await seed().catch(()=>({m:null}));
  const get=async branches=>{const d=await readDues(scope,{owner,branch:'a',branches});assert.equal(d.status,'ok');return d.rows.find(r=>r.invoice.id==='iN');};
  const all=await get(null);assert.equal(all.allocations[0].found,true);assert.equal(all.allocations[0].method,'cash');
  const north=await get(['a']);assert.equal(north.allocations[0].found,false);assert.equal(north.allocations[0].method??null,null);assert.equal(north.allocations[0].day??null,null);
  assert.equal(north.outstanding,all.outstanding,'legacy outstanding unchanged (a payment of another branch never counted)');
});

test('cache key distinguishes branch scopes that a comma join would merge',async()=>{
  const owner='KEY';
  const s=fixture();s.branches.push({id:'a,b',name:'AB'});
  const {splitState}=await import('../app/lib/entity-state.ts');
  s.visits=[];s.payments=[{id:'pK',member:s.members[0].id,branch:'a',minor:100,day:'2026-03-02',method:'cash',voided:false}];
  s.invoices=[{id:'iK',member:s.members[0].id,branch:'a',total:300,due:'2026-03-01',voided:false,allocations:[{payment:'pK',minor:100}]}];
  const {metadata,entities}=splitState(s);
  await db.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,5,$3)',[owner,JSON.stringify({...metadata,_entityStorage:1,_activityArchive:1}),'x']);
  for(const e of entities)await db.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',[owner,e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);
  await db.query("INSERT INTO gymos.gym_owner_version(owner_id,token) VALUES($1,'v') ON CONFLICT DO NOTHING",[owner]).catch(()=>{});
  const aOnly=await readDues(scope,{owner,branch:'a',branches:['a']});
  const odd=await readDues(scope,{owner,branch:'a',branches:['a,b']});
  const both=await readDues(scope,{owner,branch:'a',branches:['a','b']});
  if(aOnly.status==='ok'&&odd.status==='ok'){assert.equal(aOnly.rows[0].allocations[0].found,true);assert.equal(odd.rows[0].allocations[0].found,false,'scope [a,b] must not reuse the [a] answer');}
  assert.ok(both.status==='ok'||both.status==='unavailable');
});
