import {test,after} from 'node:test';import assert from 'node:assert/strict';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const real=await bootstrapDb();globalThis.__postDb=real;after(()=>real.close());
const {GET}=await import('../app/api/workspace/member-history/route.ts');
const {splitState}=await import('../app/lib/entity-state.ts');
const {club}=await import('./hot-ops-fixture.mjs');
const license={mode:'perpetual',status:'active',starts_at:'2026-01-01T00:00:00Z',ends_at:null,maintenance_until:null};
const ctx=(owner,x={})=>{globalThis.__qaContext={owner,tenantId:'t-'+owner,role:'owner',branches:null,license,user:{userId:'staff',displayName:'tester'},...x};};
async function seed(owner,{legacy=false,grants}={}){
  const s=club(1);const seen=new Set();for(const v of s.visits){if(v.leftAt)continue;if(seen.has(v.member))v.leftAt=v.at.slice(0,11)+'23:00:00.000Z';else seen.add(v.member);}
  if(grants)s.settings.receptionGrants={staff:grants};
  const {metadata,entities}=splitState(s);
  for(const t of ['gym_entities','gym_states'])await real.query(`DELETE FROM gymos.${t} WHERE ${t==='gym_states'?'user_id':'owner_id'}=$1`,[owner]);
  await real.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,5,$3)',[owner,JSON.stringify(legacy?(()=>{const x={...metadata};delete x._entityStorage;return x;})():{...metadata,_entityStorage:1,_activityArchive:1}),new Date().toISOString()]);
  if(!legacy)for(const e of entities)await real.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',[owner,e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);
  return s;
}
const get=(owner,q)=>GET(new Request('https://example.test/api/workspace/member-history?'+new URLSearchParams(q),{headers:{'X-GymOS-Tenant':'t-'+owner}}));
test('GET member-history: flag, auth, params, role and branch scope, paging, legacy layout',async()=>{
  const s=await seed('A');const m=s.members.find(x=>s.visits.filter(v=>v.member===x.id).length>2)||s.members[0];
  delete process.env.GYMOS_MEMBER_HISTORY;ctx('A');
  assert.equal((await get('A',{member:m.id,collection:'visits'})).status,404,'flag off: not found');
  process.env.GYMOS_MEMBER_HISTORY='1';
  try{
    globalThis.__qaContext=null;assert.equal((await get('A',{member:m.id,collection:'visits'})).status,401);ctx('A');
    assert.equal((await get('A',{member:m.id,collection:'members'})).status,400);
    assert.equal((await get('A',{member:m.id,collection:'visits',limit:'0'})).status,400);assert.equal((await get('A',{member:m.id,collection:'visits',limit:'101'})).status,400);assert.equal((await get('A',{member:m.id,collection:'visits',before:'x'})).status,400);
    const all=[];let before;for(let i=0;i<50;i++){const r=await get('A',{member:m.id,collection:'visits',limit:'2',...(before!==undefined?{before}:{})});assert.equal(r.status,200);const j=await r.json();all.push(...j.rows.map(x=>x.id));if(j.next===null)break;before=String(j.next);}
    assert.deepEqual(all,s.visits.filter(v=>v.member===m.id).map(v=>v.id).reverse(),'pages equal the member visit list newest-first');
    assert.equal((await get('A',{member:'nobody',collection:'visits'})).status,404);
    ctx('A',{branches:['zzz']});assert.equal((await get('A',{member:m.id,collection:'visits'})).status,404,'member outside the caller branches: not found, never empty');
    ctx('A',{branches:[m.branch]});assert.equal((await get('A',{member:m.id,collection:'visits'})).status,200);
    ctx('A',{role:'reception'});assert.equal((await get('A',{member:m.id,collection:'payments'})).status,403,'reception without payment grants cannot read payments');assert.equal((await get('A',{member:m.id,collection:'visits'})).status,200,'but can read visits');
    await seed('A',{grants:['payment.add']});ctx('A',{role:'reception'});assert.equal((await get('A',{member:m.id,collection:'payments'})).status,200,'reception with a payment grant can');
    ctx('B');await seed('B');ctx('A');assert.equal((await get('A',{member:m.id,collection:'visits'})).status,200);
    await seed('L',{legacy:true});ctx('L');assert.equal((await get('L',{member:m.id,collection:'visits'})).status,501,'legacy layout: unsupported, not empty');
  }finally{delete process.env.GYMOS_MEMBER_HISTORY;}
});
