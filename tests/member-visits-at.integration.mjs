import {test,after} from 'node:test';import assert from 'node:assert/strict';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const real=await bootstrapDb();globalThis.__postDb=real;after(()=>real.close());
const {GET}=await import('../app/api/workspace/member-history/route.ts');
const {splitState}=await import('../app/lib/entity-state.ts');
const {club}=await import('./hot-ops-fixture.mjs');
const license={mode:'perpetual',status:'active',starts_at:'2026-01-01T00:00:00Z',ends_at:null,maintenance_until:null};
const ctx=(owner,x={})=>{globalThis.__qaContext={owner,tenantId:'t-'+owner,role:'owner',branches:null,license,user:{userId:'staff',displayName:'tester'},...x};};
async function seed(owner,s){const {metadata,entities}=splitState(s);
  for(const t of ['gym_entities','gym_states'])await real.query(`DELETE FROM gymos.${t} WHERE ${t==='gym_states'?'user_id':'owner_id'}=$1`,[owner]);
  await real.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,5,$3)',[owner,JSON.stringify({...metadata,_entityStorage:1}),'2026-03-15']);
  for(const e of entities)await real.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',[owner,e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);}
const get=(q)=>GET(new Request('https://example.test/api/workspace/member-history?'+new URLSearchParams({collection:'visits',order:'at',...q}),{headers:{'X-GymOS-Tenant':'t-A'}}));
const iso=(d,t='09:00:00.000')=>`2026-02-${d}T${t}Z`;
function withVisits(list){const s=club(1);const m=s.members[0];s.visits=s.visits.filter(v=>v.member!==m.id);
  list.forEach(([id,at,branch],i)=>s.visits.push({id:'t-'+id,member:m.id,branch:branch??m.branch,day:at.slice(0,10),at,leftAt:at}));return {s,m};}
async function pageAll(member,limit){const out=[];let cursor;for(let i=0;i<100;i++){const r=await get({member,limit:String(limit),...(cursor?{cursor}:{})});assert.equal(r.status,200);const j=await r.json();out.push(...j.rows.map(x=>x.id));if(!j.nextCursor)return out;cursor=j.nextCursor;}throw Error('no end');}
test('order=at equals the legacy profile sort (at desc via localeCompare, ties in position order) across page sizes',async()=>{
  process.env.GYMOS_MEMBER_HISTORY='1';ctx('A');
  try{
    // late-synced visits (low position, later at), exact ties, same-day different times, out of order positions
    const list=[['v1',iso('10')],['v2',iso('20')],['v3',iso('05')],['v4',iso('20')],['v5',iso('20')],['v6',iso('10','23:59:59.999')],['v7',iso('10','00:00:00.000')],['v8',iso('01')],['v9',iso('20')]];
    const {s,m}=withVisits(list);await seed('A',s);
    const expected=s.visits.filter(v=>v.member===m.id).slice().sort((a,b)=>b.at.localeCompare(a.at)).map(v=>v.id);
    assert.notDeepEqual(expected,s.visits.filter(v=>v.member===m.id).map(v=>v.id).reverse(),'fixture must differ from position order');
    for(const limit of [1,2,3,4,100])assert.deepEqual(await pageAll(m.id,limit),expected,'limit '+limit);
    // branch scope: rows of another branch never appear, and the guard looks only at in-scope rows
    const other=s.branches.find(b=>b.id!==m.branch).id;const w=withVisits([['a1',iso('03')],['a2',iso('04'),other],['a3','garbage',other]]);await seed('A',w.s);
    ctx('A',{branches:[w.m.branch]});assert.deepEqual(await pageAll(w.m.id,5),['t-a1'],'out-of-scope malformed row neither leaks nor blocks');
    ctx('A');
    // malformed at in scope: cannot prove the order, fail closed
    const bad=withVisits([['b1',iso('03')],['b2','2026-02-04T09:00:00Z']]);await seed('A',bad.s);
    assert.equal((await get({member:bad.m.id})).status,501,'non-canonical at: unsupported, never a guessed order');
    const bad2=withVisits([['c1',iso('03')]]);bad2.s.visits.push({id:'t-c2',member:bad2.m.id,branch:bad2.m.branch,day:'2026-02-04',leftAt:'2026-02-04T10:00:00.000Z'});await seed('A',bad2.s);
    assert.equal((await get({member:bad2.m.id})).status,501,'missing at: unsupported');
    // cursor and param validation
    await seed('A',withVisits([['d1',iso('03')]]).s);const mid=(await real.query("SELECT payload->>'member' AS m FROM gymos.gym_entities WHERE owner_id='A' AND collection='visits' LIMIT 1")).rows[0].m;
    assert.equal((await get({member:mid,cursor:'nope'})).status,400);assert.equal((await get({member:mid,cursor:"x|1"})).status,400);
    assert.equal((await GET(new Request('https://example.test/api/workspace/member-history?member='+mid+'&collection=payments&order=at',{headers:{'X-GymOS-Tenant':'t-A'}}))).status,400,'order=at is visits only');
    assert.equal((await get({member:'nobody'})).status,404);
  }finally{delete process.env.GYMOS_MEMBER_HISTORY;}
});
