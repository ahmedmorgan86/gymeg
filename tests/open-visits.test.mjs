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
const {readOpenVisits}=await import('../app/lib/open-visits-page.ts');
const {checkinProfile,checkinProfileFromOpen,checkinPick,openNow,consumedMap}=await import('../app/lib/checkin-profile.ts');
const scope=(o,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);return work(c);});
let sd=11;const rnd=()=>{sd=(sd*1664525+1013904223)>>>0;return sd/2**32;};const pick=a=>a[Math.floor(rnd()*a.length)];
test('open visits == legacy !leftAt filter; popup selection == checkinProfile over consecutive states; falsy leftAt fails closed',async()=>{
  const NOW=Date.parse('2026-03-14T12:00:00.000Z');
  const s=fixture();s.visits=[];s.payments=[];s.invoices=[];s.generation='v1';
  const open=new Set();let n=0;
  for(const m of s.members){const b=m.branch;for(let k=0;k<5;k++){const isOpen=k===0&&rnd()<.5,at=new Date(NOW-Math.floor(rnd()*400000)).toISOString();s.visits.push({id:'v'+n++,member:m.id,branch:b,day:at.slice(0,10),at,...(rnd()<.3?{activeAt:new Date(NOW-Math.floor(rnd()*300000)).toISOString()}:{}),...(isOpen?{}:{leftAt:at})});}}
  await seed('O1',s);const cur=await current('O1');
  for(const branch of [...new Set(cur.members.map(m=>m.branch))]){
    const r=await readOpenVisits(scope,{owner:'O1',branch});assert.equal(r.status,'ok');
    const legacy=cur.visits.filter(v=>v.branch===branch&&!v.leftAt);
    assert.deepEqual(r.open.map(v=>v.id),legacy.map(v=>v.id));
    // consecutive states: next = previous with new activity on some open visits
    const prev=structuredClone(cur),next=structuredClone(cur);
    for(const v of next.visits.filter(v=>v.branch===branch&&!v.leftAt)){if(rnd()<.5)v.activeAt=new Date(NOW-Math.floor(rnd()*100000)).toISOString();}
    const members=new Set(next.members.filter(m=>m.branch===branch&&!m.archived).map(m=>m.id));
    const before=new Map(prev.visits.filter(v=>v.branch===branch&&!v.leftAt).map(v=>[v.id,v.activeAt??v.at]));
    const lazy=checkinProfileFromOpen(before,next.visits.filter(v=>v.branch===branch&&!v.leftAt).map(({id,member,at,activeAt})=>({id,member,at,...(activeAt?{activeAt}:{})})),members,NOW);
    assert.equal(lazy,checkinProfile(prev,next,branch,NOW));
  }
  assert.equal(checkinProfileFromOpen(null,[],new Set(),NOW),null);
  // legacy `!leftAt`: '' , 0, 0.0, -0, false are open; a number/boolean/object/array/'' must make the server read fail closed (never a silent empty)
  const b=cur.visits[0].branch,id0="'"+cur.visits[0].id+"'";
  for(const lit of ['""','0','0.0','-0','false','5','{}','[]']){
    await db.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{leftAt}','"+lit+"'::jsonb) WHERE owner_id='O1' AND entity_id="+id0);
    assert.deepEqual(await readOpenVisits(scope,{owner:'O1',branch:b}),{status:'unavailable',reason:'odd-leftAt'},lit);
  }
  await db.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{leftAt}','null'::jsonb) WHERE owner_id='O1' AND entity_id="+id0);
  assert.equal((await readOpenVisits(scope,{owner:'O1',branch:b})).status,'ok'); // JSON null is open, exactly like legacy
});
test('failed interval keeps the previous map; a member registered after the packet is carried, not lost; reopened id is the documented divergence',()=>{
  const NOW=Date.parse('2026-03-14T12:00:00.000Z'),t=ms=>new Date(NOW-ms).toISOString();
  const before=new Map([['a','x']]);
  // check-in during a failed interval: the map was kept, so the next success still sees it as new
  const open=[{id:'a',member:'m1',at:'x'},{id:'b',member:'m2',at:t(30000)}];
  assert.equal(checkinPick(before,open,new Set(['m1','m2']),NOW).member,'m2');
  // member m3 registered after the packet: not in members -> carried, then shown on the next packet that knows it
  const o2=[{id:'c',member:'m3',at:t(10000)}];
  const r1=checkinPick(new Map(),o2,new Set(['m1']),NOW);assert.equal(r1.member,null);assert.deepEqual(r1.carry.map(v=>v.id),['c']);
  const r2=checkinPick(new Map([['c',t(10000)]]),o2,new Set(['m1','m3']),NOW,r1.carry);assert.equal(r2.member,'m3');
  // a carried entry that is no longer open or out of the window is dropped
  assert.equal(checkinPick(new Map(),[],new Set(['m3']),NOW,r1.carry).member,null);
  assert.equal(checkinPick(new Map(),o2,new Set(['m3']),NOW+500000,[]).member,null);
  // documented: legacy before also holds closed ids (id unchanged => not new); lazy only has open ids (=> new). Normal same-day reentry updates activeAt; this synthetic unchanged-key reopen is outside that path.
  assert.equal(checkinPick(new Map(),[{id:'z',member:'m1',at:t(1000)}],new Set(['m1']),NOW).member,'m1');
});

test('delayed read / retry use elapsed server time and never consume future entries unseen',()=>{
  const SERVER=Date.parse('2026-03-14T12:00:00.000Z'),RECV=5_000_000,iso=ms=>new Date(SERVER+ms).toISOString();
  // packet received at RECV; the open read answers 90s later (or a retry at 95s): now must be server+90s / +95s, not the frozen server time
  assert.equal(openNow(SERVER,RECV,RECV+90000),SERVER+90000);assert.equal(openNow(undefined,RECV,RECV+95000),RECV+95000);
  const before=new Map(),members=new Set(['m1']);
  const checkin=[{id:'a',member:'m1',at:iso(150000)}]; // activated 150s after the packet's serverNow
  // frozen-clock (old behaviour) at +0: 150s is beyond now+60s -> excluded; with elapsed time at +95s it is inside [now-120s, now+60s]
  assert.equal(checkinPick(before,checkin,members,SERVER).member,null);
  assert.equal(checkinPick(before,checkin,members,openNow(SERVER,RECV,RECV+95000)).member,'m1');
  // an entry beyond now+60s is NOT remembered as seen, so it still counts as new when the window reaches it
  const map=consumedMap(checkin,SERVER);assert.equal(map.size,0);
  assert.equal(checkinPick(map,checkin,members,SERVER+100000).member,'m1');
  // an entry already inside the window is remembered (no repeat popup)
  assert.equal(checkinPick(consumedMap(checkin,SERVER+100000),checkin,members,SERVER+110000).member,null);
});
