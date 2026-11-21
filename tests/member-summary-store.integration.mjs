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
const strip=x=>JSON.parse(JSON.stringify(x));
const NOWS=['2026-03-15T12:00:00.000Z','2026-03-15T15:00:00.000Z','2026-03-20T22:30:00.000Z','2026-04-01T00:30:00.000Z','2027-01-02T10:00:00.000Z'];
async function seed(owner,state){
  state=structuredClone(state);const op=state.visits.filter(v=>v.member==='plain'&&!v.leftAt);for(const v of op.slice(1))v.leftAt=v.day+'T23:00:00.000Z'; // one open visit per member
  const {metadata,entities}=splitState(state);
  await db.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,5,$3)',[owner,JSON.stringify({...metadata,_entityStorage:1,_activityArchive:1}),'x']);
  for(const e of entities)await db.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',[owner,e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);
}
const read=(owner,b=null)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);return readMemberCandidates(c,owner,b);});
async function current(owner){const r=await db.query("SELECT collection,payload FROM gymos.gym_entities WHERE owner_id=$1 ORDER BY position,entity_id",[owner]);const s=fixture();const by=c=>r.rows.filter(x=>x.collection===c).map(x=>x.payload);s.members=by('members');s.visits=by('visits');s.payments=by('payments');s.invoices=by('invoices');return s;}
async function same(owner,label){
  const res=await read(owner);assert.ok(typeof res==='object',label+': '+res);const s=await current(owner);let n=0;
  for(const {member,stored} of res.candidates){
    for(const now of NOWS){const want=memberSummary(s,member,now),got=deriveSummary(strip(stored),member,s.settings,now);
      for(const k of ['period','issue','remaining','debt','status','used','visitsRemaining','paid'])assert.deepEqual(strip(got[k]),strip(want[k]),`${label} ${member.id} @ ${now}: ${k}`);
      assert.equal(got.current?.id,want.current?.id,`${label} ${member.id} current`);assert.equal(got.last?.id,want.last?.id,`${label} ${member.id} last`);n++;}
  }
  return {res,n};
}
test('existing owner is unready until backfill; backfill then reads exactly the oracle',async()=>{
  await seed('O1',fixture());
  for(const tb of ['gym_member_summary_ready','gym_member_summaries','gym_member_summary_dirty'])await db.query(`DELETE FROM gymos.${tb} WHERE owner_id='O1'`); // an owner that predates the migration
  assert.equal(await read('O1'),'unready');
  await db.query("SELECT gymos.backfill_member_summaries('O1')");
  const {res,n}=await same('O1','backfilled');assert.equal(res.refreshed,res.candidates.length);assert.ok(n>=50);
  const again=await read('O1');assert.equal(again.refreshed,0,'second read recomputes nothing');
});
test('every writer path marks only the affected member dirty, and the refresh is exact afterwards',async()=>{
  const dirty=async o=>(await db.query('SELECT member_id FROM gymos.gym_member_summary_dirty WHERE owner_id=$1 ORDER BY 1',[o])).rows.map(r=>r.member_id).filter(m=>m!=='archived'); // archived members are not candidates, so they are never refreshed
  assert.deepEqual(await dirty('O1'),[]);
  // direct SQL update of a visit (what SQL auto-exit does)
  await db.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{leftAt}','\"2026-03-15T13:00:00.000Z\"') WHERE owner_id='O1' AND collection='visits' AND payload->>'member'='plain' AND payload->>'leftAt' IS NULL");
  assert.deepEqual(await dirty('O1'),['plain']);await same('O1','after auto-exit style update');assert.deepEqual(await dirty('O1'),[]);
  // delete a payment, void an invoice, move a visit to another member, add a visit, change a member
  await db.query("DELETE FROM gymos.gym_entities WHERE owner_id='O1' AND collection='payments' AND entity_id='p1'");assert.deepEqual(await dirty('O1'),['plain']);await same('O1','payment deleted');
  await db.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{voided}','true') WHERE owner_id='O1' AND collection='invoices' AND entity_id='i3'");assert.deepEqual(await dirty('O1'),['quota']);await same('O1','invoice voided');
  await db.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{member}','\"sess\"') WHERE owner_id='O1' AND collection='visits' AND payload->>'member'='quota' AND payload->>'day'='2026-03-05'");
  assert.deepEqual(await dirty('O1'),['quota','sess']);await same('O1','visit moved');
  await db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES('O1','visits','vnew',9999,'a','{\"id\":\"vnew\",\"member\":\"legacy\",\"branch\":\"a\",\"day\":\"2026-03-16\",\"at\":\"2026-03-16T09:00:00.000Z\"}')");
  assert.deepEqual(await dirty('O1'),['legacy']);await same('O1','visit added');
  await db.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{expires}','\"2026-03-17\"') WHERE owner_id='O1' AND collection='members' AND entity_id='plain'");assert.deepEqual(await dirty('O1'),['plain']);await same('O1','member changed');
  await db.query("DELETE FROM gymos.gym_entities WHERE owner_id='O1' AND collection='members' AND entity_id='none'");assert.deepEqual(await dirty('O1'),['none']);
  const r=await same('O1','member deleted');assert.ok(!r.res.candidates.some(c=>c.member.id==='none'));
  // an unrelated collection does not mark anything
  await db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES('O1','plans','plx',99,'a','{\"id\":\"plx\"}')");assert.deepEqual(await dirty('O1'),[]);
});
test('persistSpace full path (a real write) keeps summaries exact',async()=>{
  const cur=await current('O1');const rev=Number((await db.query("SELECT revision FROM gymos.gym_states WHERE user_id='O1'")).rows[0].revision);
  const {readEntitySpace}=await import('../app/lib/entity-store.ts');const space=await readEntitySpace('O1');
  const next=structuredClone(space.state);next.payments.push({id:'pnew',member:'plain',branch:'a',minor:25,day:'2026-03-15',method:'cash',voided:false});
  await persistSpace('O1',space,next);
  await same('O1','after persistSpace');
});
test('unready, truncate, beyond-cap and too-many-dirty fail closed without a history read',async()=>{
  await seed('O2',{...fixture(),members:[],visits:[],payments:[],invoices:[]});
  const r=await read('O2');assert.equal(typeof r,'object','fresh empty owner is ready from creation');assert.equal(r.candidates.length,0);
  // too many dirty
  await db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) SELECT 'O2','members','m'||g,g,'a',jsonb_build_object('id','m'||g,'branch','a','joined','2026-01-01','expires','2026-12-31') FROM generate_series(1,$1) g",[REFRESH_MAX+1]);
  assert.equal(await read('O2'),'too-many-dirty');
  // the bounded refresher drains a mass-dirty owner in waves of at most REFRESH_MAX, then reads work
  let left=Infinity,waves=0;while(left>0&&waves++<10){const x=await db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner','O2',true)");return refreshDirtySummaries(c,'O2');});assert.ok(x.refreshed<=REFRESH_MAX);left=x.remaining;}
  assert.equal(left,0);assert.ok(waves>=2,'needed more than one wave');assert.equal((await read('O2')).candidates.length,REFRESH_MAX+1);
  // beyond the member cap: refused before any visit/payment/invoice read
  await db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) SELECT 'O2','members','x'||g,100000+g,'a',jsonb_build_object('id','x'||g,'branch','a') FROM generate_series(1,$1) g",[MEMBER_CANDIDATE_MAX]);
  const seen=[];const spy={query:(sql,v)=>{seen.push(sql);return db.query(sql,v);}};
  const rr=await db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner','O2',true)");return readMemberCandidates({query:(s,v)=>{seen.push(s);return c.query(s,v);}},'O2',null);});
  assert.equal(rr,'too-many-members');assert.ok(!seen.some(s=>/'visits'|'payments'|'invoices'/.test(s)),'no history query ran');
  // truncate drops readiness for every owner
  await db.query('TRUNCATE gymos.gym_entities');
  assert.equal(await read('O1'),'unready');assert.equal(await read('O2'),'unready');
});
test('an owner whose counters are unready or beyond the 20,000,000-byte rule is refused before any history row is read',async()=>{
  await seed('O3',{...fixture(),members:[{id:'a1',branch:'a',joined:'2026-01-01',expires:'2026-12-31'}],visits:[],payments:[],invoices:[]});
  const probe=async()=>{const seen=[];const r=await db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner','O3',true)");return readMemberCandidates({query:(s,v)=>{seen.push(s);return c.query(s,v);}},'O3',null);});return {r,history:seen.some(s=>/'visits'|'payments'|'invoices'/.test(s)&&/payload->>'member'/.test(s))};};
  await db.query("UPDATE gymos.gym_entity_counters SET payload_bytes=20000001 WHERE owner_id='O3' AND collection='members'");
  let x=await probe();assert.equal(x.r,'over-state-bound');assert.equal(x.history,false);
  await db.query("DELETE FROM gymos.gym_entity_counters WHERE owner_id='O3' AND collection='_ready'");
  x=await probe();assert.equal(x.r,'over-state-bound');assert.equal(x.history,false);
});
