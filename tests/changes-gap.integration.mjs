import {test,after,mock} from 'node:test';import assert from 'node:assert/strict';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const real=await bootstrapDb();let rowsRead=0;
globalThis.__postDb={query:async(s,v)=>{const r=await real.query(s,v);rowsRead+=r.rows?.length??0;return r;},transaction:fn=>real.transaction(c=>fn({query:async(s,v)=>{const r=await c.query(s,v);rowsRead+=r.rows?.length??0;return r;}}))};
after(()=>real.close());
const {POST}=await import("../app/api/workspace/route.ts");const {GET}=await import("../app/api/workspace/changes/route.ts");
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
const get=(owner,after)=>GET(new Request('https://example.test/api/workspace/changes?after='+after,{headers:{origin:'https://example.test','X-GymOS-Tenant':'t-'+owner}})).then(async r=>({status:r.status,body:await r.json()}));
test('/changes: an event log that does not reach the authoritative revision gives a snapshot, never an empty delta (forced events insert failure after the revision bump)',async()=>{
  const s=await seed('G');ctx('G');delete process.env.GYMOS_HOT_OPS;
  const m=s.members.find(x=>!x.demo&&!s.visits.some(v=>v.member===x.id&&!v.leftAt));
  const pay=(minor,req,revision)=>post('G',{operation:{type:'payment.add',branch:m.branch,id:m.id,minor,method:'cash'},requestId:req,revision});
  // healthy write: events exist at revision 6 and a client at 5 gets them
  assert.equal((await pay(250,'req-gap-aaaaaaaaaa1',5)).status,200);assert.equal(await rev('G'),6);
  const ok=await get('G',5);assert.equal(ok.status,200);assert.equal(ok.body.requiresSnapshot,false);assert.ok(ok.body.events.length>0);assert.equal(ok.body.toRevision,6);
  // up to date: empty, no snapshot
  const same=await get('G',6);assert.deepEqual([same.body.requiresSnapshot,same.body.events.length],[false,0]);
  const ahead=await get('G',9);assert.deepEqual([ahead.body.requiresSnapshot,ahead.body.toRevision],[true,6]);
  // force the events insert to fail inside persistSpace's savepoint: the revision still advances, no event row is written
  await real.query("CREATE OR REPLACE FUNCTION gymos.qa_fail_events() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced events failure'; END $$");
  await real.query("CREATE TRIGGER qa_fail_events BEFORE INSERT ON gymos.workspace_events FOR EACH ROW EXECUTE FUNCTION gymos.qa_fail_events()");
  try{
    const w=await pay(251,'req-gap-aaaaaaaaaa2',6);assert.equal(w.status,200);assert.equal(await rev('G'),7,'revision advanced');
    const maxEv=Number((await real.query("SELECT max(revision) m FROM gymos.workspace_events WHERE owner_id='G'")).rows[0].m);assert.equal(maxEv,6,'no event row for revision 7');
    // a client at 6 is behind the authoritative 7 with zero events to show: it must be told to take a snapshot
    const gap=await get('G',6);assert.equal(gap.status,200);assert.equal(gap.body.requiresSnapshot,true,'zero events but behind: snapshot, not an empty delta');assert.equal(gap.body.events.length,0);assert.equal(gap.body.toRevision,7);
    // a client already at 7 is current
    const cur=await get('G',7);assert.deepEqual([cur.body.requiresSnapshot,cur.body.events.length],[false,0]);
    // the client-side consumer: requiresSnapshot makes the sync manager call onSnapshotRequired (load), not advance silently
    const {WorkspaceSyncManager}=await import('../app/lib/workspace-sync.ts');let snap=0,upd=0;
    const origFetch=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify(gap.body),{status:200,headers:{'content-type':'application/json'}});
    try{const sm=new WorkspaceSyncManager({tenantId:'t-G',owner:'G',initialRevision:6,getCurrentPacket:()=>({revision:6,state:{}}),onPacketUpdate:()=>{upd++;},onSnapshotRequired:()=>{snap++;}});const r=await sm.pullDeltas();assert.equal(r,false);}finally{globalThis.fetch=origFetch;}
    assert.deepEqual([snap,upd],[1,0],'client takes a snapshot and applies nothing');
    // interior hole: the trigger is removed, a healthy write lands at revision 8; the log now holds 6 and 8 but not 7
    await real.query("DROP TRIGGER IF EXISTS qa_fail_events ON gymos.workspace_events");
    assert.equal((await pay(252,'req-gap-aaaaaaaaaa3',7)).status,200);assert.equal(await rev('G'),8);
    const mx=Number((await real.query("SELECT max(revision) m FROM gymos.workspace_events WHERE owner_id='G'")).rows[0].m);assert.equal(mx,8,'revision 8 has events, so max(events) equals the authoritative revision');
    const hole=await get('G',6);assert.equal(hole.body.requiresSnapshot,true,'interior hole (7 missing, 8 present): snapshot, not the events of 8 alone');assert.equal(hole.body.events.length,0);
    const fromHealthy=await get('G',8);assert.deepEqual([fromHealthy.body.requiresSnapshot,fromHealthy.body.events.length],[false,0]);
    // a client that took the snapshot at 8 and then sees a healthy 9 gets exactly that revision's events
    assert.equal((await pay(253,'req-gap-aaaaaaaaaa4',8)).status,200);const next=await get('G',8);assert.equal(next.body.requiresSnapshot,false);assert.ok(next.body.events.length>0&&next.body.events.every(e=>e.revision===9));
  }finally{await real.query("DROP TRIGGER IF EXISTS qa_fail_events ON gymos.workspace_events");await real.query("DROP FUNCTION IF EXISTS gymos.qa_fail_events()");}
});
test('/changes: a batch never ends inside a revision (250-event truncation cannot skip events); a single oversized revision takes a snapshot',async()=>{
  await seed('H');ctx('H');
  const ev=(rev,n,tag)=>real.query("INSERT INTO gymos.workspace_events(id,owner_id,tenant_id,revision,event_type,collection,entity_id,branch,payload) SELECT $3::text||'-'||g,'H','t-H',$1::int,'entity.upsert','payments',$3::text||'-'||g,'a',jsonb_build_object('id',$3::text||'-'||g) FROM generate_series(1,$2::int) g",[rev,n,tag]);
  await ev(6,200,'r6');await ev(7,100,'r7');await ev(8,10,'r8');await real.query("UPDATE gymos.gym_states SET revision=8 WHERE user_id='H'");
  const b1=await get('H',5);assert.equal(b1.body.requiresSnapshot,false);assert.equal(b1.body.hasMore,true);assert.equal(b1.body.toRevision,6,'revision 7 is cut at the 250 boundary, so the batch stops after 6');
  assert.equal(b1.body.events.length,200);assert.ok(b1.body.events.every(e=>e.revision===6));
  const b2=await get('H',6);assert.equal(b2.body.requiresSnapshot,false);assert.equal(b2.body.hasMore,false);assert.equal(b2.body.toRevision,8);
  assert.equal(b2.body.events.length,110);assert.deepEqual([...new Set(b2.body.events.map(e=>e.revision))],[7,8],'revision 7 arrives whole (100 of 100), then 8');
  // exact fit and one-over
  await real.query("DELETE FROM gymos.workspace_events WHERE owner_id='H'");await ev(6,250,'x6');await ev(7,1,'x7');await real.query("UPDATE gymos.gym_states SET revision=7 WHERE user_id='H'");
  const e1=await get('H',5);assert.equal(e1.body.events.length,250);assert.equal(e1.body.toRevision,6);assert.equal(e1.body.hasMore,true);const e2=await get('H',6);assert.deepEqual([e2.body.events.length,e2.body.hasMore,e2.body.toRevision],[1,false,7]);
  // one revision larger than the batch cannot be served atomically
  await real.query("DELETE FROM gymos.workspace_events WHERE owner_id='H'");await ev(6,300,'big');await real.query("UPDATE gymos.gym_states SET revision=6 WHERE user_id='H'");
  const big=await get('H',5);assert.equal(big.body.requiresSnapshot,true);assert.equal(big.body.events.length,0);
});
