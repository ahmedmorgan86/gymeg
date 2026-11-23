import {test} from 'node:test';import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const db=globalThis.__hotDb=await bootstrapDb();
registerHooks({
  resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}},
  load(url,ctx,next){if(url.endsWith('/app/lib/database.ts'))return{format:'module',shortCircuit:true,source:`export const getPool=()=>({connect:async()=>({query:(sql,v)=>globalThis.__hotDb.query(sql,v),release(){}})});export async function withScope(owner,work){return globalThis.__hotDb.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);return work(c);});}`};return next(url,ctx);},
});
const {persistSpace,readEntitySpace}=await import('../app/lib/entity-store.ts');
const {postgresBackend,readHotSlice,MAX_SLICE}=await import('../app/lib/workspace-slice.ts');
const {applyOperation}=await import('../app/lib/domain.ts');
const {splitState}=await import('../app/lib/entity-state.ts');

const {normalize}=await import('../app/lib/extensions.ts');
const {hotPlan,applyHot}=await import('../app/lib/hot-op-plans.ts');
const {RECENT_EVENTS}=await import('../app/lib/activity-archive.ts');
const {club,NOW}=await import('./hot-ops-fixture.mjs');
const {STATE_BYTE_LIMIT}=await import('../app/lib/workspace-slice.ts');
const scope=async(owner,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);return work(c);});
const be=postgresBackend(scope);
const bytes=s=>new TextEncoder().encode(s).byteLength;
async function seed(owner,state,photos={}){
  const {metadata,entities}=splitState(state);
  await db.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,5,$3)',[owner,JSON.stringify({...metadata,_entityStorage:1,_activityArchive:1}),new Date().toISOString()]);
  for(const e of entities)await db.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',[owner,e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);
  for(const [m,c] of Object.entries(photos))await db.query('INSERT INTO gymos.gym_photos(owner_id,member_id,content) VALUES($1,$2,$3)',[owner,m,c]);
}
/** Counters equal a brute-force recount, and the bound is >= the exact bytes the caller's rule measures (JSON.stringify of the assembled full state). */
async function verify(owner,label){
  const k=Object.fromEntries((await db.query('SELECT collection,row_count::int AS n,payload_bytes::int AS b FROM gymos.gym_entity_counters WHERE owner_id=$1',[owner])).rows.map(r=>[r.collection,r]));
  assert.ok(k._ready,label+': marker');
  const real=(await db.query("SELECT collection,count(*)::int AS n,sum(octet_length(payload::text))::int AS b FROM gymos.gym_entities WHERE owner_id=$1 GROUP BY 1",[owner])).rows;
  for(const r of real)assert.deepEqual({n:k[r.collection]?.n,b:k[r.collection]?.b},{n:r.n,b:r.b},label+': '+r.collection);
  for(const c of Object.keys(k))if(c!=='_ready'&&c!=='photos'&&!real.some(r=>r.collection===c))assert.equal(k[c].n,0,label+': stale '+c);
  const ph=(await db.query("SELECT count(*)::int AS n,coalesce(sum(octet_length(to_jsonb(content)::text)+9),0)::int AS b FROM gymos.gym_photos WHERE owner_id=$1",[owner])).rows[0];
  assert.deepEqual({n:k.photos?.n??0,b:k.photos?.b??0},{n:ph.n,b:ph.b},label+': photos');
  const exact=bytes(JSON.stringify((await readEntitySpace(owner)).state)),bound=(await be.counters(owner))?.bound;
  assert.ok(bound>=exact,`${label}: bound ${bound} must be >= exact ${exact}`);
  return {exact,bound};
}
const ids=n=>{let k=0;return()=>`${n}-${k++}-aaaaaaaaaaaaaaaaaaaaaaaa`;};
function prep(no){const s=club(no);const seen=new Set();for(const v of s.visits){if(v.leftAt)continue;if(seen.has(v.member))v.leftAt=v.at.slice(0,11)+'23:00:00.000Z';else seen.add(v.member);}return s;}

test('counters and the size bound stay exact across every writer: full persist, slice persist, SQL auto-exit, direct SQL, restore, photos',async()=>{
  const s=prep(3);const photo='data:image/png;base64,'+'QUJD'.repeat(50);
  const photos=Object.fromEntries(s.members.slice(0,3).map(m=>[m.id,photo]));
  await seed('W',s,photos);let r=await verify('W','after seed');console.log('seed: exact',r.exact,'bound',r.bound);
  // full persist (diff) path
  {const cur=await readEntitySpace('W');const m=cur.state.members.find(m=>!m.demo)??cur.state.members[0];const st=applyOperation(cur.state,{type:'payment.add',branch:m.branch,id:m.id,minor:250,method:'cash'},NOW,'tester',ids('f'));st.receipts.push({id:'u:full',digest:'d'});await persistSpace('W',{state:cur.state,revision:cur.revision},st);}
  await verify('W','after full persist');
  // slice persist path
  {const m=s.members.find(m=>!m.demo)??s.members[0];const op={type:'payment.add',branch:m.branch,id:m.id,minor:100,method:'cash'};const hot=await readHotSlice(be,'W',hotPlan(op),normalize);assert.ok(hot,'hot path available with counters ready');
   const st=applyHot(structuredClone(hot.state),hot.counts,op,NOW,'tester',ids('s'));st.receipts.push({id:'u:slice',digest:'d2'});
   await persistSpace('W',{state:hot.state,revision:hot.revision},st,false,{positions:hot.positions,trims:[{collection:'events',keep:RECENT_EVENTS},{collection:'receipts',keep:1000}]});}
  await verify('W','after slice persist');
  // SQL auto-exit: an ancient open visit is closed by the scheduler function, outside persistSpace
  {await db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES('W','visits','ae1',990,'a','{\"id\":\"ae1\",\"member\":\"ae-member\",\"branch\":\"a\",\"day\":\"2020-01-01\",\"at\":\"2020-01-01T00:00:00.000Z\"}')");
   await verify('W','after open visit insert');
   const n=(await db.query('SELECT gymos.close_attendance_sessions() AS n')).rows[0].n;assert.ok(n>=1,'auto-exit closed '+n+' visits');
   const v=(await db.query("SELECT payload FROM gymos.gym_entities WHERE owner_id='W' AND entity_id='ae1'")).rows[0].payload;assert.equal(v.exitType,'automatic');}
  await verify('W','after SQL auto-exit');
  // direct SQL insert, update, delete
  await db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES('W','announcements','zz1',999,'a','{\"id\":\"zz1\",\"text\":\"héllo \\u00e9 😀\"}')");
  await verify('W','after direct insert');
  await db.query("UPDATE gymos.gym_entities SET payload=payload||'{\"extra\":[1,2,3.5,1e30,\"é\"]}' WHERE owner_id='W' AND entity_id='zz1'");
  await verify('W','after direct update');
  await db.query("DELETE FROM gymos.gym_entities WHERE owner_id='W' AND collection='visits' AND position<3");
  await verify('W','after direct delete');
  // restore (persistSpace restore=true replaces the state)
  {const cur=await readEntitySpace('W');const st=structuredClone(cur.state);st.payments=st.payments.slice(0,2);st.visits=st.visits.slice(0,5);await persistSpace('W',{state:cur.state,revision:cur.revision},st,true);}
  await verify('W','after restore');
  // photos: insert, update, delete
  const mid=s.members[5].id;await db.query("INSERT INTO gymos.gym_photos(owner_id,member_id,content) VALUES('W',$1,'data:image/png;base64,AAAA')",[mid]);await verify('W','after photo insert');
  await db.query("UPDATE gymos.gym_photos SET content='data:image/png;base64,'||repeat('Z',500) WHERE owner_id='W' AND member_id=$1",[mid]);await verify('W','after photo update');
  await db.query("DELETE FROM gymos.gym_photos WHERE owner_id='W'");await verify('W','after photo delete');
  // recount reproduces the maintained values for an existing owner, and marks it ready
  const before=(await db.query("SELECT collection,row_count::int n,payload_bytes::int b FROM gymos.gym_entity_counters WHERE owner_id='W' AND row_count<>0 ORDER BY 1")).rows;
  await db.query("SELECT gymos.recount_entity_counters('W')");
  const after=(await db.query("SELECT collection,row_count::int n,payload_bytes::int b FROM gymos.gym_entity_counters WHERE owner_id='W' AND row_count<>0 ORDER BY 1")).rows;
  assert.deepEqual(after,before,'recount equals maintained counters');
});

test('an owner with rows that existed before the counters is not trusted until recounted',async()=>{
  await db.query("INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES('L','{}',1,'x')");
  await db.query("DELETE FROM gymos.gym_entity_counters WHERE owner_id='L'"); // simulate a pre-existing club: no marker
  await db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES('L','members','m1',0,'a','{\"id\":\"m1\"}')");
  assert.equal(await be.counters('L'),null,'no marker: no counters, hot path falls back');
  assert.equal(await be.count('L','members'),1,'count(*) fallback is exact');
  await db.query("SELECT gymos.recount_entity_counters('L')");assert.ok((await be.counters('L')).bound>0);assert.equal(await be.count('L','members'),1);
});

test('jsonb text length is an upper bound of compact JSON.stringify length for hostile payloads',async()=>{
  let x=99;const r=n=>{x=(x*1103515245+12345)&0x7fffffff;return x%n;};
  const atoms=['é','😀','日本','\u0000','\n','"','\\','\u2028','</script>',' ','0','é'.repeat(3)];
  const num=()=>[0,1,-1,3.5,1e21,1e-7,123456789012,Number.MAX_SAFE_INTEGER,1.5e300,-0.25][r(10)];
  const val=d=>{const t=r(d>2?4:7);return t===0?num():t===1?atoms[r(atoms.length)].repeat(1+r(4)):t===2?r(2)===0:t===3?null:t===4?Array.from({length:r(4)},()=>val(d+1)):t===5?{}:Object.fromEntries(Array.from({length:r(4)},(_,i)=>[atoms[r(atoms.length)]+i,val(d+1)]));};
  let worst=0;
  for(let i=0;i<400;i++){const p={id:'r'+i,v:val(0),w:val(0)};const js=bytes(JSON.stringify(p));
   await db.query("INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES('R','{}',1,'x') ON CONFLICT DO NOTHING");
   const row=(await db.query("SELECT octet_length($1::jsonb::text) AS n",[JSON.stringify(p)])).rows[0];
   assert.ok(Number(row.n)>=js,`pg ${row.n} < js ${js} for ${JSON.stringify(p).slice(0,120)}`);worst=Math.max(worst,Number(row.n)-js);}
  console.log('max overhead bytes in 400 samples',worst);
});

test('hot path refuses an already-over bound; growth is proven per write in persistSpace',async()=>{
  await seed('G',prep(4));
  const m=(await readEntitySpace('G')).state.members.find(m=>!m.demo);const op={type:'payment.add',branch:m.branch,id:m.id,minor:1,method:'cash'};
  assert.ok(await readHotSlice(be,'G',hotPlan(op),normalize),'small club: hot');
  await db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES('G','announcements','big',9999,'a',jsonb_build_object('id','big','text',repeat('x',$1::int)))",[STATE_BYTE_LIMIT+1000]);
  const b=(await be.counters('G')).bound;assert.ok(b>STATE_BYTE_LIMIT,'bound '+b+' is already over the rule');
  assert.equal(await readHotSlice(be,'G',hotPlan(op),normalize),null,'no proven room: fall back to the full path');
});

test('TRUNCATE can never leave a silently wrong counter: it drops all markers so callers fall back',async()=>{
  await seed('T',prep(5));assert.ok(await be.counters('T'));
  await db.query('TRUNCATE gymos.gym_photos');assert.equal(await be.counters('T'),null,'photos truncate: unready');
  await db.query("SELECT gymos.recount_entity_counters('T')");assert.ok(await be.counters('T'));
  await db.query('TRUNCATE gymos.gym_entities');assert.equal(await be.counters('T'),null,'entities truncate: unready');
  assert.equal(await be.count('T','members'),0,'count(*) fallback is exact');
});

test('lifecycle: a pre-existing owner never becomes ready by deletes; a deleted and recreated owner restarts from zero; negative counters fail closed',async()=>{
  await db.query("INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES('P','{}',1,'x')");
  await db.query("DELETE FROM gymos.gym_entity_counters WHERE owner_id='P'"); // simulate an owner that predates the counters
  await db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES('P','visits','pv',0,'a','{\"id\":\"pv\",\"member\":\"pm\"}')");
  await db.query("DELETE FROM gymos.gym_entity_counters WHERE owner_id='P' AND collection='_ready'");
  await db.query("DELETE FROM gymos.gym_entities WHERE owner_id='P'");
  assert.equal(await be.counters('P'),null,'negative deltas without a marker are never trusted');
  await db.query("DELETE FROM gymos.gym_states WHERE user_id='P'");
  await db.query("INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES('P','{}',1,'x')");
  const k=await be.counters('P');assert.ok(k,'recreated empty owner is ready');assert.deepEqual(k.counts,{},'and starts from zero, no leftover negative deltas');
  await db.query("INSERT INTO gymos.gym_entity_counters(owner_id,collection,row_count,payload_bytes) VALUES('P','visits',-1,-27)");
  assert.equal(await be.counters('P'),null,'negative counter: fail closed');
  await db.query("DELETE FROM gymos.gym_entity_counters WHERE owner_id='P'");
});

test('counter reads reject unsafe integers and corrupt values',async()=>{
  await db.query("INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES('U','{}',1,'x')");
  for(const [rc,pb] of [['9007199254740993','0'],['0','9223372036854775807'],['5','-1']]){
    await db.query("DELETE FROM gymos.gym_entity_counters WHERE owner_id='U' AND collection='visits'");
    await db.query("INSERT INTO gymos.gym_entity_counters(owner_id,collection,row_count,payload_bytes) VALUES('U','visits',$1,$2)",[rc,pb]);
    assert.equal(await be.counters('U'),null,rc+'/'+pb);
  }
  await db.query("DELETE FROM gymos.gym_entity_counters WHERE owner_id='U'");
});
