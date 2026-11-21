import {test,after} from 'node:test';import assert from 'node:assert/strict';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const real=await bootstrapDb();let rowsRead=0;
globalThis.__postDb={query:async(s,v)=>{const r=await real.query(s,v);rowsRead+=r.rows?.length??0;return r;},transaction:fn=>real.transaction(c=>fn({query:async(s,v)=>{const r=await c.query(s,v);rowsRead+=r.rows?.length??0;return r;}}))};
after(()=>real.close());
const {POST}=await import('../app/api/workspace/route.ts');
const {splitState}=await import('../app/lib/entity-state.ts');
const {club}=await import('./hot-ops-fixture.mjs');
const license={mode:'perpetual',status:'active',starts_at:'2026-01-01T00:00:00Z',ends_at:null,maintenance_until:null};
function ctx(owner,extra={}){globalThis.__qaContext={owner,tenantId:'t-'+owner,role:'owner',branches:null,license,user:{userId:'staff',displayName:'tester'},...extra};}
async function seed(owner){
  const s=club(1);const seen=new Set();for(const v of s.visits){if(v.leftAt)continue;if(seen.has(v.member))v.leftAt=v.at.slice(0,11)+'23:00:00.000Z';else seen.add(v.member);}
  const {metadata,entities}=splitState(s);
  await real.query('DELETE FROM gymos.gym_entities WHERE owner_id=$1',[owner]);await real.query('DELETE FROM gymos.gym_states WHERE user_id=$1',[owner]);await real.query('DELETE FROM gymos.gym_activity_archive WHERE owner_id=$1',[owner]);await real.query('DELETE FROM gymos.workspace_events WHERE owner_id=$1',[owner]);
  await real.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,5,$3)',[owner,JSON.stringify({...metadata,_entityStorage:1,_activityArchive:1}),new Date().toISOString()]);
  for(const e of entities)await real.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',[owner,e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);
  return s;
}
const post=(owner,body,delta=true)=>POST(new Request('https://example.test/api/workspace',{method:'POST',headers:{origin:'https://example.test','content-type':'application/json','X-GymOS-Tenant':'t-'+owner,...(delta?{'X-GymOS-Sync-Mode':'delta'}:{})},body:JSON.stringify(body)}));
const rev=async o=>(await real.query('SELECT revision FROM gymos.gym_states WHERE user_id=$1',[o])).rows[0].revision;
const cnt=async(o,c)=>(await real.query('SELECT count(*)::int n FROM gymos.gym_entities WHERE owner_id=$1 AND collection=$2',[o,c])).rows[0].n;
test('POST /api/workspace: flag off vs on over the real entity layout',async()=>{
  const s=await seed('F');await seed('S');
  const m=s.members.find(x=>!x.demo&&!s.visits.some(v=>v.member===x.id&&!v.leftAt));
  const op={type:'payment.add',branch:m.branch,id:m.id,minor:250,method:'cash'};
  const body={operation:op,requestId:'req-aaaaaaaaaaaaaaaa1',revision:5};
  delete process.env.GYMOS_HOT_OPS;ctx('F');rowsRead=0;
  const rf=await post('F',body);const full=rowsRead;const jf=await rf.json();
  process.env.GYMOS_HOT_OPS='1';
  try{
    ctx('S');rowsRead=0;const rs=await post('S',body);const hot=rowsRead;const js=await rs.json();
    assert.equal(rf.status,200);assert.equal(rs.status,200);assert.deepEqual(js,jf,'same delta response body');assert.deepEqual(js,{ok:true,revision:6});
    assert.equal(await rev('S'),await rev('F'));assert.equal(await cnt('S','payments'),await cnt('F','payments'));assert.equal(await cnt('S','receipts'),await cnt('F','receipts'));
    assert.ok(hot<full,`hot path reads fewer rows than the full path (${hot} < ${full})`);console.log('POST rows read: full',full,'hot',hot);
    // replay answers from the full path, no second write
    const rr=await post('S',{...body,revision:6});assert.equal(rr.status,200);assert.deepEqual(await rr.json(),{ok:true,revision:6,replay:true});assert.equal(await rev('S'),6);
    // same requestId, different operation: 409 replay
    const r409=await post('S',{...body,revision:6,operation:{...op,minor:251}});assert.equal(r409.status,409);assert.equal((await r409.json()).error,'replay');
    // stale revision: 409 conflict, no write
    const rc=await post('S',{...body,requestId:'req-aaaaaaaaaaaaaaaa2',revision:5});assert.equal(rc.status,409);assert.equal((await rc.json()).error,'conflict');assert.equal(await rev('S'),6);
    // non-delta: full path and a packet response
    const rn=await post('S',{...body,requestId:'req-aaaaaaaaaaaaaaaa3',revision:6},false);assert.equal(rn.status,200);assert.ok((await rn.json()).state,'non-delta returns a packet');assert.equal(await rev('S'),7);
    // branch-scoped staff outside their branch: forbidden before and after the flag
    ctx('S',{branches:['zzz']});const rb=await post('S',{...body,requestId:'req-aaaaaaaaaaaaaaaa4',revision:7});assert.equal(rb.status,403);assert.equal(await rev('S'),7);
    // invalid operation under the flag still returns the full path's rule error
    ctx('S');const bad=await post('S',{operation:{type:'payment.add',branch:m.branch,id:m.id,minor:-5,method:'cash'},requestId:'req-aaaaaaaaaaaaaaaa5',revision:7});assert.equal(bad.status,400);assert.equal(await rev('S'),7);
  }finally{delete process.env.GYMOS_HOT_OPS;}
});
