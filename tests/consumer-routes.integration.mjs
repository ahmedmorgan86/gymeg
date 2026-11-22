// Actual route handlers (flag, auth, branch scope, role, 501 guard, support session) over a REAL entity-layout club on PGlite. Run with --import ./tests/workspace-post-loader.mjs.
// Oracle for the role gate: packetQueries(ctx,settings) (the same collections the packet would carry for that caller).
import {test,after} from 'node:test';import assert from 'node:assert/strict';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const real=await bootstrapDb();globalThis.__postDb=real;after(()=>real.close());
const {splitState}=await import('../app/lib/entity-state.ts');const {packetQueries}=await import('../app/lib/workspace-packet.ts');
const {club}=await import('./hot-ops-fixture.mjs');
const license={mode:'perpetual',status:'active',starts_at:'2026-01-01T00:00:00Z',ends_at:null,maintenance_until:null};
const ctx=(owner,x={})=>{globalThis.__qaContext={owner,tenantId:'t-'+owner,role:'owner',branches:null,license,user:{userId:'staff',displayName:'tester'},...x};};
async function seed(owner,{legacy=false}={}){
  const s=club(3);const {metadata,entities}=splitState(s);
  for(const t of ['gym_entities','gym_states'])await real.query(`DELETE FROM gymos.${t} WHERE ${t==='gym_states'?'user_id':'owner_id'}=$1`,[owner]);
  await real.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,5,$3)',[owner,JSON.stringify(legacy?(()=>{const x={...metadata};delete x._entityStorage;return x;})():{...metadata,_entityStorage:1,_activityArchive:1}),new Date().toISOString()]);
  if(!legacy)for(const e of entities)await real.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',[owner,e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);
  return s;
}
// route, flag, query for branch B, required collections (as the route checks them), extra owner-only rule
const R=[
 ['attendance','GYMOS_ATTENDANCE',b=>({branch:b,day:'2026-03-05'}),['visits','members'],false],
 ['today-visits','GYMOS_TODAY_VISITS',b=>({branch:b,day:'2026-03-05'}),['visits','members'],false],
 ['last-visits','GYMOS_LAST_VISITS',b=>({branch:b,today:'2026-03-05'}),['visits','members'],false],
 ['visit-trend','GYMOS_VISIT_TREND',b=>({branch:b,today:'2026-03-05',period:'7'}),['visits','members'],false],
 ['open-visits','GYMOS_OPEN_VISITS',b=>({branch:b}),['visits','members'],false],
 ['payments','GYMOS_PAYMENTS',b=>({branch:b,mode:'summary',today:'2026-03-05',period:'30'}),['payments','members'],false],
 ['payments','GYMOS_PAYMENTS',b=>({branch:b,mode:'export'}),['payments','members'],false],
 ['dues','GYMOS_DUES',b=>({branch:b}),['invoices','payments','members'],true],
 ['report-payments','GYMOS_REPORT_PAYMENTS',b=>({branch:b,from:'2026-03-01',to:'2026-03-31'}),['payments','invoices','members'],false],
];
test('consumer routes: flag, auth, params, branch scope, role gate (packetQueries oracle), support session, 501 on legacy layout',async()=>{
  const s=await seed('A');await seed('L',{legacy:true});
  const call=async(name,owner,q)=>(await import(`../app/api/workspace/${name}/route.ts`)).GET(new Request('https://example.test/api/workspace/'+name+'?'+new URLSearchParams(q),{headers:{'X-GymOS-Tenant':'t-'+owner}}));
  const seen={};
  for(const [name,flag,q,cols,ownerOnly] of R){
    const tag=name+JSON.stringify(q('a'));
    delete process.env[flag];ctx('A');assert.equal((await call(name,'A',q('a'))).status,404,tag+' flag off');
    process.env[flag]='1';
    try{
      globalThis.__qaContext=null;assert.equal((await call(name,'A',q('a'))).status,401,tag+' anonymous');
      ctx('A');assert.equal((await call(name,'A',{...q('a'),branch:''})).status,400,tag+' no branch');
      ctx('A',{branches:['b']});assert.equal((await call(name,'A',q('a'))).status,403,tag+' foreign branch');
      ctx('A',{branches:['a']});assert.equal((await call(name,'A',q('a'))).status,200,tag+' branch-limited own branch');
      ctx('L');assert.equal((await call(name,'L',q('a'))).status,501,tag+' legacy layout fails closed');
      // support session (read-only owner) may read
      ctx('A',{support:{id:'session',reason:'QA',expiresAt:'2027-01-01T00:00:00Z',readOnly:true}});assert.equal((await call(name,'A',q('a'))).status,200,tag+' support read');
      for(const role of ['owner','manager','reception']){
        ctx('A',{role,branches:role==='owner'?null:['a']});
        const have=new Set(packetQueries(globalThis.__qaContext,s.settings).flatMap(x=>x.collections));
        const expect=(ownerOnly&&role==='reception')||!cols.every(c=>have.has(c))?403:200;
        const r=await call(name,'A',q('a'));assert.equal(r.status,expect,tag+' role '+role);seen[role+':'+name+':'+expect]=1;
        if(expect===200){const j=await r.json();assert.equal(typeof j.status,'string',tag+' body');}
      }
    }finally{delete process.env[flag];}
  }
  // the oracle must actually exercise both outcomes: reception is refused where its packet lacks money/invoice collections, and owners are served everywhere
  for(const n of ['payments','dues','report-payments'])assert.ok(seen['reception:'+n+':403'],'reception refused on '+n);
  for(const [n] of R)assert.ok(seen['owner:'+n+':200'],'owner served on '+n);
});
