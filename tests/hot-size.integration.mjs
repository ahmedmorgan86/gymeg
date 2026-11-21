import {test,after,mock} from 'node:test';import assert from 'node:assert/strict';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const real=await bootstrapDb();let rowsRead=0;
globalThis.__postDb={query:async(s,v)=>{const r=await real.query(s,v);rowsRead+=r.rows?.length??0;return r;},transaction:fn=>real.transaction(c=>fn({query:async(s,v)=>{const r=await c.query(s,v);rowsRead+=r.rows?.length??0;return r;}}))};
after(()=>real.close());
const {POST}=await import('../app/api/workspace/route.ts');
const {splitState}=await import('../app/lib/entity-state.ts');
const {club,NOW}=await import('./hot-ops-fixture.mjs');
const {applyOperation}=await import('../app/lib/domain.ts');
const {normalize}=await import('../app/lib/extensions.ts');
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

async function seedSmall(owner){
  const {emptyState}=await import('../app/lib/domain.ts');
  const st=emptyState();st.branches=[{id:'a',name:'A'},{id:'b',name:'B'}];st.settings.timezone='Africa/Cairo';
  st.members=['m1','m2'].map(id=>({id,name:'Member '+id,phone:'0100000000'+id.slice(1),branch:'a',joined:'2026-01-01',expires:'2026-12-31',archived:false,demo:false}));
  const {metadata,entities}=splitState(st);
  for(const t of ['gym_entities','gym_states'])await real.query(`DELETE FROM gymos.${t} WHERE ${t==='gym_states'?'user_id':'owner_id'}=$1`,[owner]);
  await real.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,5,$3)',[owner,JSON.stringify({...metadata,_entityStorage:1,_activityArchive:1}),new Date().toISOString()]);
  for(const e of entities)await real.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',[owner,e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);
}
const {readEntitySpace}=await import('../app/lib/entity-store.ts');
const bytesOf=async o=>new TextEncoder().encode(JSON.stringify((await readEntitySpace(o)).state)).byteLength;
const N=2_000_000,LIMIT=20_000_000;
async function seedBig(owner,target){
  await seedSmall(owner);
  const at='2026-03-15T08:00:00.'+'0'.repeat(N)+'Z'; // Date.parse accepts any number of fractional digits
  await real.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,'visits','vbig',0,'a',$2)",[owner,JSON.stringify({id:'vbig',member:'m1',branch:'a',day:'2026-03-15',at,leftAt:'2026-03-15T09:00:00.000Z'})]);
  await real.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,'announcements','fill',0,'a',$2)",[owner,JSON.stringify({id:'fill',text:'x'})]);
  const base=await bytesOf(owner);
  await real.query("UPDATE gymos.gym_entities SET payload=jsonb_build_object('id','fill','text',repeat('x',$2::int)) WHERE owner_id=$1 AND entity_id='fill'",[owner,1+target-base]);
  return bytesOf(owner);
}
test('regression: a reopened same-day visit that duplicates a huge historical timestamp must not push a hot write past the 20,000,000-byte rule',async()=>{
  mock.timers.enable({apis:['Date'],now:Date.parse(NOW)});
  try{
    const res={};
    for(const [o,flag] of [['F',false],['S',true]]){
      const cur=await seedBig(o,18_600_000);assert.ok(cur>18_500_000&&cur<18_700_000,'current state '+cur);
      if(flag)process.env.GYMOS_HOT_OPS='1';else delete process.env.GYMOS_HOT_OPS;
      try{ctx(o);const before=await rev(o);const r=await post(o,{operation:{type:'visit.add',branch:'a',id:'m1'},requestId:'req-dddddddddddddddd',revision:before});res[o]={status:r.status,body:await r.json(),moved:await rev(o)-before,bytes:await bytesOf(o),cur};}finally{delete process.env.GYMOS_HOT_OPS;}
    }
    console.log(JSON.stringify({full:{...res.F,body:undefined},hot:{...res.S,body:undefined}}));
    assert.equal(res.F.status,413,'the exact full path rejects this shape (fixture must reproduce)');
    assert.equal(res.S.status,res.F.status,'hot flag on: same status');assert.deepEqual(res.S.body,res.F.body,'same body');
    assert.equal(res.S.moved,0,'nothing persisted');assert.ok(res.S.bytes<=LIMIT,'stored state never exceeds the rule: '+res.S.bytes);assert.equal(res.S.bytes,res.S.cur,'state unchanged');
  }finally{mock.timers.reset();}
});
