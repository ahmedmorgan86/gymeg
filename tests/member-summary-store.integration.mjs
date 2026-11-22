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
const NOWS=['2026-03-15T12:00:00.000Z','2026-03-15T15:00:00.000Z','2026-03-20T22:30:00.000Z','2026-04-01T00:30:00.000Z','2027-01-02T10:00:00.000Z'];
async function seed(owner,state){
  state=structuredClone(state);const op=state.visits.filter(v=>v.member==='plain'&&!v.leftAt);for(const v of op.slice(1))v.leftAt=v.day+'T23:00:00.000Z'; // one open visit per member
  const {metadata,entities}=splitState(state);
  await db.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,5,$3)',[owner,JSON.stringify({...metadata,_entityStorage:1,_activityArchive:1}),'x']);
  for(const e of entities)await db.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',[owner,e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);
}
const AS='2026-03-14T00:00:00.000Z'; // compute clock for the stored horizon (2026-03-13), before every test clock
const read=(owner,b=null,opts={refresh:true,now:AS})=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);return readMemberCandidates(c,owner,b,opts);});
const via=(owner,hook,opts={refresh:true,now:AS})=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);return readMemberCandidates({query:async(s,v)=>{const r=await hook(c,s,v,'before');const x=r??await c.query(s,v);await hook(c,s,v,'after');return x;}},owner,null,opts);});
async function current(owner){const r=await db.query("SELECT collection,payload FROM gymos.gym_entities WHERE owner_id=$1 ORDER BY position,entity_id",[owner]);const s=fixture();const by=c=>r.rows.filter(x=>x.collection===c).map(x=>x.payload);s.members=by('members');s.visits=by('visits');s.payments=by('payments');s.invoices=by('invoices');return s;}
async function same(owner,label){
  const res=await read(owner);assert.equal(res.status,'ok',label+': '+res.status);const s=await current(owner);let n=0;
  for(const {member,stored} of res.candidates){
    for(const now of NOWS){const want=ORACLE(s,member,now),got=deriveSummary(strip(stored),member,s.settings,now);
      for(const k of ['period','issue','remaining','debt','status','used','visitsRemaining','paid'])assert.deepEqual(strip(got[k]),strip(want[k]),`${label} ${member.id} @ ${now}: ${k}`);
      assert.equal(got.current?.id,want.current?.id,`${label} ${member.id} current`);assert.equal(got.last?.id,want.last?.id,`${label} ${member.id} last`);n++;}
  }
  return {res,n};
}
test('existing owner is unready until backfill; backfill then reads exactly the oracle',async()=>{
  await seed('O1',fixture());
  for(const tb of ['gym_member_summary_ready','gym_member_summaries','gym_member_summary_dirty'])await db.query(`DELETE FROM gymos.${tb} WHERE owner_id='O1'`); // an owner that predates the migration
  assert.equal((await read('O1')).status,'unready');
  await db.query("SELECT gymos.backfill_member_summaries('O1')");
  const {res,n}=await same('O1','backfilled');assert.equal(res.refreshed,res.candidates.length);assert.ok(n>=50);
  const again=await read('O1');assert.equal((await read('O1',null,{})).status,'ok','read-only read of clean owner');assert.equal(again.refreshed,0,'second read recomputes nothing');
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
  assert.deepEqual(await dirty('O1'),['none'],'the reader never writes: the orphan mark of a deleted member stays until the refresher runs');
  await db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner','O1',true)");return refreshDirtySummaries(c,'O1');});assert.deepEqual(await dirty('O1'),[]);
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
test('bounded waves store the same summaries whatever the wave size; the snapshot scope works',async()=>{
  const {withSnapshotScope}=await import('../app/lib/member-summary-scope.ts');
  await seed('G1',fixture());
  const drain=async max=>{await db.query("SELECT gymos.backfill_member_summaries('G1')");let x,waves=0;for(let i=0;i<50;i++){x=await withSnapshotScope('G1',c=>refreshDirtySummaries(c,'G1',max,AS));assert.equal(x.status,'ok');assert.ok(x.refreshed<=max,'wave bounded by max');waves++;if(x.remaining===0)break;}
    return{waves,rows:(await db.query("SELECT member_id,stored FROM gymos.gym_member_summaries WHERE owner_id='G1' ORDER BY 1")).rows};};
  const a=await drain(500),b=await drain(3);
  assert.ok(a.rows.length>=10);assert.ok(b.waves>a.waves,'small waves take more calls');assert.deepEqual(strip(b.rows),strip(a.rows),'wave size does not change stored summaries');
  // snapshot scope maps a serialization failure to busy, not an exception
  await db.query("SELECT gymos.backfill_member_summaries('G1')");
  const bz=await withSnapshotScope('G1',c=>readMemberCandidates({query:async(s,v)=>{if(/INSERT INTO gymos.gym_member_summaries/.test(s)){const e=new Error('ser');e.code='40001';throw e;}return c.query(s,v);}},'G1',null,{refresh:true,now:AS}));assert.equal(bz.status,'busy');
  // the 40001 rolled back to the savepoint: the transaction is usable and the marks are still there
  assert.ok(Number((await db.query("SELECT count(*) n FROM gymos.gym_member_summary_dirty WHERE owner_id='G1'")).rows[0].n)>0);
});
test('there is no whole-collection history read: only per-member index lookups',async()=>{
  const src=(await import('node:fs')).readFileSync(new URL('../app/lib/member-summary-store.ts',import.meta.url),'utf8');
  assert.ok(!/readGrouped|useGrouped|groupedInFlight/.test(src));
  assert.ok(!/FROM gymos\.gym_entities WHERE owner_id=\$1 AND collection=\$2 LIMIT/.test(src),'no unfiltered collection read');
});
test('unready, truncate, beyond-cap and too-many-dirty fail closed without a history read',async()=>{
  await seed('O2',{...fixture(),members:[],visits:[],payments:[],invoices:[]});
  const r=await read('O2');assert.equal(r.status,'ok','fresh empty owner is ready from creation');assert.equal(r.candidates.length,0);
  // too many dirty
  await db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) SELECT 'O2','members','m'||g,g,'a',jsonb_build_object('id','m'||g,'branch','a','joined','2026-01-01','expires','2026-12-31') FROM generate_series(1,$1) g",[REFRESH_MAX+1]);
  assert.equal((await read('O2')).status,'too-many-dirty');
  // the bounded refresher drains a mass-dirty owner in waves of at most REFRESH_MAX, then reads work
  let left=Infinity,waves=0;while(left>0&&waves++<10){const x=await db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner','O2',true)");return refreshDirtySummaries(c,'O2');});assert.equal(x.status,'ok');assert.ok(x.refreshed<=REFRESH_MAX);left=x.remaining;}
  assert.equal(left,0);assert.ok(waves>=2,'needed more than one wave');assert.equal((await read('O2')).candidates.length,REFRESH_MAX+1);
  // beyond the member cap: refused before any visit/payment/invoice read
  await db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) SELECT 'O2','members','x'||g,100000+g,'a',jsonb_build_object('id','x'||g,'branch','a') FROM generate_series(1,$1) g",[MEMBER_CANDIDATE_MAX]);
  const seen=[];const spy={query:(sql,v)=>{seen.push(sql);return db.query(sql,v);}};
  const rr=await db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner','O2',true)");return readMemberCandidates({query:(s,v)=>{seen.push(s);return c.query(s,v);}},'O2',null);});
  assert.equal(rr.status,'too-many-members');assert.ok(!seen.some(s=>/'visits'|'payments'|'invoices'/.test(s)),'no history query ran');
  // truncate drops readiness for every owner
  await db.query('TRUNCATE gymos.gym_entities');
  assert.equal((await read('O1')).status,'unready');assert.equal((await read('O2')).status,'unready');
});
test('an owner whose counters are unready or beyond the 20,000,000-byte rule is refused before any history row is read',async()=>{
  await seed('O3',{...fixture(),members:[{id:'a1',branch:'a',joined:'2026-01-01',expires:'2026-12-31'}],visits:[],payments:[],invoices:[]});
  const probe=async()=>{const seen=[];const r=await db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner','O3',true)");return readMemberCandidates({query:(s,v)=>{seen.push(s);return c.query(s,v);}},'O3',null,{refresh:true});});return {r,history:seen.some(s=>/'visits'|'payments'|'invoices'/.test(s)&&/payload->>'member'/.test(s))};};
  await db.query("UPDATE gymos.gym_entity_counters SET payload_bytes=20000001 WHERE owner_id='O3' AND collection='members'");
  let x=await probe();assert.equal(x.r.status,'over-state-bound');assert.equal(x.history,false);
  await db.query("DELETE FROM gymos.gym_entity_counters WHERE owner_id='O3' AND collection='_ready'");
  x=await probe();assert.equal(x.r.status,'over-state-bound');assert.equal(x.history,false);
});

async function mk(owner,cancel){
  const mem=x=>JSON.stringify({id:'m1',branch:'a',joined:'2026-01-01',expires:'2026-12-31',membershipPeriods:[{id:'p1',plan:'pl',start:'2026-01-01',end:'2026-12-31',visits:3,cancelled:x}]});
  await db.query("INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,'{\"_entityStorage\":1}',1,'x')",[owner]);
  await db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,'members','m1',1,'a',$2)",[owner,mem(false)]);
  await db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,'visits','v1',1,'a','{\"id\":\"v1\",\"member\":\"m1\",\"branch\":\"a\",\"day\":\"2026-03-01\",\"at\":\"2026-03-01T10:00:00.000Z\",\"leftAt\":\"2026-03-01T11:00:00.000Z\"}')",[owner]);
  return mem;
}
test('interleave: a member change committed after the caller read the member row is never stored stale with its mark cleared',async()=>{
  const mem=await mk('R1');let fired=false;
  const r=await via('R1',async(c,s,v,phase)=>{if(phase==='after'&&!fired&&/collection='members'/.test(s)&&/LIMIT/.test(s)&&/ORDER BY/.test(s)){fired=true;await c.query("UPDATE gymos.gym_entities SET payload=$1 WHERE owner_id='R1' AND collection='members' AND entity_id='m1'",[mem(true)]);}return null;});
  assert.equal(r.status,'ok');assert.equal(r.candidates[0].member.membershipPeriods[0].cancelled,true,'returned member is the re-read one');
  const st=(await db.query("SELECT stored->'periods' p,stored->'tail' t FROM gymos.gym_member_summaries WHERE owner_id='R1'")).rows[0];assert.deepEqual(st.p,{},'stored from the re-read member (period cancelled: no totals)');assert.deepEqual(st.t,[]);
  assert.equal((await db.query("SELECT count(*)::int n FROM gymos.gym_member_summary_dirty WHERE owner_id='R1'")).rows[0].n,0);
});
test('stale owner is read-only without refresh:true (no writes), and refresh waits are explicit statuses',async()=>{
  await mk('R2');
  const before=(await db.query("SELECT count(*)::int n FROM gymos.gym_member_summaries WHERE owner_id='R2'")).rows[0].n;
  assert.equal((await read('R2',null,{})).status,'stale');assert.equal((await db.query("SELECT count(*)::int n FROM gymos.gym_member_summaries WHERE owner_id='R2'")).rows[0].n,before,'nothing written');
  // a lock-timeout from a writer holding a row is reported as busy
  // a REAL aborted statement (the failing query puts the transaction in the aborted state) then 55P03: busy, the transaction stays usable and lock_timeout does not leak
  const lt0=(await db.query("SHOW lock_timeout")).rows[0].lock_timeout;let usable=null,lt1=null;
  const b=await db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner','R2',true)");
    const st=await readMemberCandidates({query:async(s,v)=>{if(/INSERT INTO gymos.gym_member_summaries/.test(s)){await c.query('SELECT 1/0').catch(()=>{});const e=new Error('lock');e.code='55P03';throw e;}return c.query(s,v);}},'R2',null,{refresh:true});
    usable=(await c.query('SELECT 1 AS one')).rows[0].one;lt1=(await c.query('SHOW lock_timeout')).rows[0].lock_timeout;return st;});
  assert.equal(b.status,'busy');assert.equal(usable,1,'transaction still usable after the abort');assert.equal(lt1,lt0,'lock_timeout restored');
  // a writer growing a collection after the counters check is detected, not read without bound
  const rc=await via('R2',async(c,s,v,phase)=>{if(phase==='after'&&/FROM gymos.gym_entity_counters/.test(s)){await c.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES('R2','visits','vgrow',50,'a','{\"id\":\"vgrow\",\"member\":\"m1\",\"branch\":\"a\",\"day\":\"2026-03-02\",\"at\":\"2026-03-02T10:00:00.000Z\"}')");}return null;});
  assert.equal(rc.status,'raced');
});
test('the stored horizon is taken from the database clock: a caller-supplied FUTURE clock is ignored (a future-dated visit is never folded early)',async()=>{
  await seed('H1',fixture());
  await db.query("SELECT gymos.backfill_member_summaries('H1')");
  const dbDay=(await db.query("SELECT (now() AT TIME ZONE 'UTC')::date::text d")).rows[0].d;
  await db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner','H1',true)");return refreshDirtySummaries(c,'H1',500,'2099-01-01T00:00:00.000Z');});
  const rows=(await db.query("SELECT stored FROM gymos.gym_member_summaries WHERE owner_id='H1'")).rows;
  assert.ok(rows.length>=10);
  for(const r of rows)assert.ok(r.stored.horizon<dbDay,`horizon ${r.stored.horizon} must be before the DB day ${dbDay}`);
  // a past clock is honored (more rows stay in the tail)
  await db.query("SELECT gymos.backfill_member_summaries('H1')");
  await db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner','H1',true)");return refreshDirtySummaries(c,'H1',500,'2026-03-10T00:00:00.000Z');});
  assert.ok((await db.query("SELECT stored FROM gymos.gym_member_summaries WHERE owner_id='H1'")).rows.every(r=>r.stored.horizon==='2026-03-09'));
});
test('owner change version moves for EVERY writer and never repeats',async()=>{
  const {readOwnerVersion}=await import('../app/lib/member-summary-store.ts');
  await seed('V1',fixture());await seed('V2',fixture());
  const v=o=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);return readOwnerVersion(c,o);});
  let last=await v('V1');assert.ok(last,'a token exists after seeding');
  const moves=async(label,fn)=>{const before=await v('V1'),other=await v('V2');await fn();const after=await v('V1');assert.ok(BigInt(after)>BigInt(before),label+': version must increase');assert.equal(await v('V2'),other,label+': another owner is untouched');};
  await moves('direct SQL insert',()=>db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES('V1','visits','vx',99999,'a','{\"id\":\"vx\",\"member\":\"plain\",\"branch\":\"a\",\"day\":\"2026-03-02\",\"at\":\"2026-03-02T10:00:00.000Z\",\"leftAt\":\"2026-03-02T11:00:00.000Z\"}')"));
  await moves('direct SQL update (auto-exit shape)',()=>db.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{leftAt}','\"2026-03-02T12:00:00.000Z\"') WHERE owner_id='V1' AND entity_id='vx'"));
  await moves('direct SQL delete',()=>db.query("DELETE FROM gymos.gym_entities WHERE owner_id='V1' AND entity_id='vx'"));
  await moves('gym_states settings update',()=>db.query("UPDATE gymos.gym_states SET payload=payload WHERE user_id='V1'"));
  await moves('persistSpace full path',async()=>{const {readEntitySpace}=await import('../app/lib/entity-store.ts');const space=await readEntitySpace('V1');const next=structuredClone(space.state);next.payments.push({id:'pv',member:'plain',branch:'a',minor:5,day:'2026-03-15',method:'cash',voided:false});await persistSpace('V1',space,next);});
  await moves('summary refresh does NOT count as a writer? (it must not bump)',async()=>{}).catch(()=>{});
  const b=await v('V1');await db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner','V1',true)");await refreshDirtySummaries(c,'V1',500,AS);});assert.equal(await v('V1'),b,'recomputing stored inputs changes no row of the club, so the token stays');
  await db.query('TRUNCATE gymos.gym_entities');assert.equal(await v('V1'),null,'after TRUNCATE there is no token, so no cache entry can match');
});
test('console candidate source: ok, unchanged, fallback, permission blanking, forbidden, token race',async()=>{
  const {readConsoleCandidates}=await import('../app/lib/member-console-source.ts');
  await seed('S1',fixture());
  const scope=(o,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);return work(c);});
  const q=(x={})=>readConsoleCandidates(scope,{owner:'S1',branch:'a',branches:null,financial:true,now:AS,...x});
  await db.query("DELETE FROM gymos.gym_member_summary_ready WHERE owner_id='S1'");
  assert.equal((await q()).status,'fallback','unready owner is a fallback, not empty and not an error');
  await db.query("SELECT gymos.backfill_member_summaries('S1')");
  const ok=await q();assert.equal(ok.status,'ok');assert.ok(ok.candidates.length>0);assert.ok(ok.candidates.every(x=>x.member.branch==='a'));
  assert.deepEqual(await q({since:ok.version}),{status:'unchanged',version:ok.version},'same version: nothing is resent');
  const blank=await q({financial:false});assert.ok(blank.candidates.every(x=>x.stored.debt===0&&x.stored.paid===0),'reception without finance gets no debt/paid');
  assert.ok(ok.candidates.some(x=>x.stored.paid>0||x.stored.debt>0),'fixture has finance to blank');
  assert.equal((await q({branches:['b']})).status,'forbidden','branch outside the caller scope');
  await db.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{note}','\"x\"') WHERE owner_id='S1' AND collection='members' AND entity_id=(SELECT entity_id FROM gymos.gym_entities WHERE owner_id='S1' AND collection='members' LIMIT 1)");
  const again=await q({since:ok.version});assert.equal(again.status,'ok');assert.notEqual(again.version,ok.version,'a writer moves the version, so the client refetches');
  // a writer landing between the token read and the row read: simulated by bumping inside the scope after the first token read
  let n=0;const racing=(o,work)=>scope(o,c=>work({query:async(s,v)=>{const r=await c.query(s,v);if(/gym_owner_version/.test(s)&&++n===2)await c.query("UPDATE gymos.gym_states SET payload=payload WHERE user_id='S1'");return r;}}));
  const r=await readConsoleCandidates(racing,{owner:'S1',branch:'a',branches:null,financial:true,now:AS});
  assert.deepEqual(r,{status:'fallback',reason:'changed-during-read'});
});
test('candidate member rows equal the packet member minus health/vitals/measurements: no sensitive field for anyone, photos as versioned URLs, 22KB photos never inline',async()=>{
  const {readConsoleCandidates}=await import('../app/lib/member-console-source.ts');const {packet}=await import('../app/lib/workspace-packet.ts');
  const s=fixture();const PHOTO='data:image/jpeg;base64,'+'A'.repeat(21900);
  s.members[0].health={notes:'secret'};s.members[0].vitals={bp:'120/80'};s.members[0].measurements=[{day:'2026-01-01',kg:80}];
  if(s.members[1]){s.members[1].health={notes:'secret2'};}
  await seed('P1',s);
  const photoRow=s.members[0].id; // the real layout: the photo lives in its own row, at the 22,000-character maximum the table allows
  await db.query("INSERT INTO gymos.gym_photos(owner_id,member_id,content) VALUES('P1',$1,$2)",[photoRow,PHOTO+'B']);
  await db.query("UPDATE gymos.gym_entities SET payload=payload||jsonb_build_object('photo',$1::text) WHERE owner_id='P1' AND collection='members' AND entity_id=$2",[PHOTO,s.members[1].id]); // a legacy inline photo on another member
  s.members[1].photo=PHOTO;
  const scope=(o,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);return work(c);});
  await db.query("SELECT gymos.backfill_member_summaries('P1')");
  for(const role of ['owner','reception']){
    const out=await readConsoleCandidates(scope,{owner:'P1',tenantId:'T1',branch:'a',branches:null,financial:role!=='reception',now:AS});assert.equal(out.status,'ok');
    const raw=JSON.stringify(out);assert.ok(!/secret|120\/80|measurements|"health"|"vitals"/.test(raw),role+': sensitive fields absent from candidates');
    assert.ok(!raw.includes('AAAAAAAAAA'),role+': no inline photo bytes');assert.ok(raw.length<out.candidates.length*3000,'payload stays small: '+raw.length);
    const pk=packet({state:structuredClone(s),revision:5},{role,branches:null,tenantId:'T1',owner:'T1',user:{userId:'u',displayName:'u'}},photoRow?{[photoRow]:require_hash(PHOTO+'B')}:undefined);
    for(const c of out.candidates){const want=pk.state.members.find(m=>m.id===c.member.id);const w=structuredClone(want);delete w.health;delete w.vitals;delete w.measurements;assert.deepEqual(c.member,w,role+' '+c.member.id+': same photo URL and fields as the packet');}
  }
});
import {createHash} from 'node:crypto';function require_hash(x){return createHash('sha256').update(x).digest('hex').slice(0,16);}
test('member detail source: equals memberSummary(packet-like state) for every member and clock, all-branch view, finance gated, bounded to the member',async()=>{
  const {readMemberDetail}=await import('../app/lib/member-detail-source.ts');
  const s=fixture();await seed('D1',s);const cur=await current('D1');
  const scope=(o,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);return work(c);});
  let n=0;
  for(const m of cur.members){
    const out=await readMemberDetail(scope,{owner:'D1',member:m.id,branches:null,financial:true,settings:cur.settings,asOf:AS});assert.equal(out.status,'ok',m.id);
    for(const now of NOWS){const want=memberSummary(cur,m,now),got=deriveSummary(strip(out.stored),m,cur.settings,now);
      for(const k of ['period','issue','remaining','debt','status','used','visitsRemaining','paid'])assert.deepEqual(strip(got[k]),strip(want[k]),`${m.id} @ ${now}: ${k}`);
      assert.equal(got.current?.id,want.current?.id);assert.equal(got.last?.id,want.last?.id);n++;}
    assert.equal(out.stored.visitCount,cur.visits.filter(v=>v.member===m.id).length,'visit count is the all-branch count the panel shows');
    assert.deepEqual(strip(out.invoices),strip(memberSummary(cur,m,NOWS[0]).invoices),'invoices: non-voided, legacy order');
    assert.deepEqual(strip(out.payments),strip(cur.payments.filter(p=>p.member===m.id)),'payments in legacy order');
  }
  assert.ok(n>0);
  const m0=cur.members[0];
  const nofin=await readMemberDetail(scope,{owner:'D1',member:m0.id,branches:null,financial:false,settings:cur.settings,asOf:AS});assert.deepEqual([nofin.payments,nofin.invoices,nofin.stored.debt,nofin.stored.paid],[[],[],0,0]);
  assert.equal((await readMemberDetail(scope,{owner:'D1',member:m0.id,branches:['zz'],financial:true,settings:cur.settings})).status,'notFound','member outside the caller branches');
  assert.equal((await readMemberDetail(scope,{owner:'D1',member:'nope',branches:null,financial:true,settings:cur.settings})).status,'notFound');
});
test('today visits source equals the legacy expressions for every branch/day (archived, demo, other-branch members, missing members)',async()=>{
  const {readTodayVisits}=await import('../app/lib/today-visits.ts');
  const s=fixture();s.members.push({...s.members[0],id:'arch',archived:true},{...s.members[0],id:'demo1',demo:true},{...s.members[0],id:'otherb',branch:'b'});
  const days=[...new Set(s.visits.map(v=>v.day))];
  s.visits.push({id:'t1',member:'arch',branch:'a',day:days[0],at:days[0]+'T08:00:00.000Z'},{id:'t2',member:'demo1',branch:'a',day:days[0],at:days[0]+'T08:05:00.000Z'},{id:'t3',member:'ghost',branch:'a',day:days[0],at:days[0]+'T08:06:00.000Z'},{id:'t4',member:'otherb',branch:'a',day:days[0],at:days[0]+'T08:07:00.000Z',activeAt:days[0]+'T08:08:00.000Z'});
  for(let i=0;i<15;i++)s.visits.push({id:'many'+i,member:'plain',branch:'a',day:days[0],at:days[0]+'T09:'+String(10+i)+':00.000Z',leftAt:days[0]+'T23:00:00.000Z'});
  await seed('TV',s);const cur=await current('TV');
  const scope=(o,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);return work(c);});
  let n=0;
  for(const branch of ['a','b','zz'])for(const day of [...days,'2030-01-01']){
    const got=await readTodayVisits(scope,{owner:'TV',branch,day});
    const dm=cur.members.filter(m=>m.branch===branch&&!m.archived&&!m.demo),om=cur.members.filter(m=>m.branch===branch&&!m.archived);
    const wantCount=cur.visits.filter(v=>v.branch===branch&&v.day===day&&dm.some(m=>m.id===v.member)).length;
    const wantLatest=cur.visits.filter(v=>v.branch===branch&&v.day===day).slice(-12).reverse().map(v=>({id:v.id,member:v.member,at:v.at,...(v.activeAt!==undefined?{activeAt:v.activeAt}:{}),name:om.find(m=>m.id===v.member)?.name??null}));
    assert.equal(got.count,wantCount,`count ${branch} ${day}`);assert.deepEqual(got.latest,wantLatest,`latest ${branch} ${day}`);n++;
  }
  assert.ok(n>=9);
  await assert.rejects(()=>readTodayVisits(scope,{owner:'TV',branch:'a',day:"2026-01-01' OR 1=1"}),RangeError);
});
test('random write sequence (insert with sessions/periodId/branch, auto-exit update, delete, move) over members sharing one period: refreshed stored summary == legacy for numeric fields and == membershipIssue over the FULL state; null derivations counted',async()=>{
  const {membershipIssue}=await import('../app/lib/extensions.ts');const {dayAt}=await import('../app/lib/domain.ts');
  const s0=fixture();s0.visits=[];s0.payments=[];s0.invoices=[];s0.members=['r1','r2','r3'].map((id,i)=>({id,name:'R '+i,phone:'0100000100'+i,branch:i<2?'a':'b',joined:'2026-01-01',expires:'2026-12-31',membershipPeriods:[{id:'shared',plan:'pl-a',start:'2026-02-01',end:'2026-12-31',visits:i===1?4:3,quotaMode:i===2?'sessions':undefined}]}));
  await seed('RW',s0);await db.query("SELECT gymos.backfill_member_summaries('RW')");
  let sd=21;const rnd=()=>{sd=(sd*1664525+1013904223)>>>0;return sd/2**32;};const pick=a=>a[Math.floor(rnd()*a.length)];
  const days=['2026-02-03','2026-02-20','2026-03-01','2026-03-05','2026-03-10','2026-03-12','2026-03-13'];let n=0,compared=0,quota=0,nulls=0;
  for(let step=0;step<60;step++){
    const ex=async q=>{try{await db.query(q[0],q[1]);return true;}catch(e){if(/gym_visit_one_open/.test(e.message))return false;throw e;}};
    const op=pick(['ins','ins','ins','exit','del','move']);
    const ids=(await db.query("SELECT entity_id FROM gymos.gym_entities WHERE owner_id='RW' AND collection='visits' ORDER BY position")).rows.map(r=>r.entity_id);
    if(op==='ins'||!ids.length){const d=pick(days),mem=pick(['r1','r2','r3']);const v={id:'w'+n,member:mem,branch:pick(['a','b']),day:d,at:d+'T0'+(n%9)+':00:00.000Z'};if(rnd()<.5)v.leftAt=d+'T0'+(n%9)+':30:00.000Z';if(rnd()<.5)v.periodId=pick(['shared','shared','other']);if(rnd()<.4)v.sessions=[{at:d+'T12:00:00.000Z',leftAt:d+'T12:20:00.000Z'}];
      if(await ex(["INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES('RW','visits',$1,$2,$3,$4)",[v.id,10000+n,v.branch,JSON.stringify(v)]]))n++;}
    else if(op==='exit')await ex(["UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{leftAt}','\"2026-03-13T18:00:00.000Z\"') WHERE owner_id='RW' AND entity_id=$1",[pick(ids)]]);
    else if(op==='del')await db.query("DELETE FROM gymos.gym_entities WHERE owner_id='RW' AND entity_id=$1",[pick(ids)]);
    else await ex(["UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{member}',to_jsonb($2::text)) WHERE owner_id='RW' AND entity_id=$1",[pick(ids),pick(['r1','r2','r3'])]]);
    const res=await read('RW');assert.equal(res.status,'ok',`step ${step} ${op}`);const s=await current('RW');
    for(const {member,stored} of res.candidates)for(const now of NOWS){
      const got=deriveSummary(strip(stored),member,s.settings,now);if(!got){nulls++;continue;}
      const want=ORACLE(s,member,now);for(const k of ['issue','remaining','status','used','visitsRemaining'])assert.deepEqual(strip(got[k]),strip(want[k]),`step ${step} ${op} ${member.id} ${now} ${k}`);
      assert.equal(got.current?.id,want.current?.id,`step ${step} ${member.id} open visit`);
      const legacyFull=membershipIssue(s,member,dayAt(now,s.settings.timezone));if(now>='2026-03-15')assert.equal(got.issue,legacyFull,`step ${step} ${member.id} vs membershipIssue(full state) ${now}`);
      compared++;if(got.issue==='quota')quota++;}
  }
  console.log('random-write coverage',JSON.stringify({compared,quota,nullDerivations:nulls}));assert.ok(compared>500&&quota>20);
});
