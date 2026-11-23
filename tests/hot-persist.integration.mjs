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
const {tryHotOperation}=await import('../app/lib/hot-route.ts');
const {RECENT_EVENTS}=await import('../app/lib/activity-archive.ts');
const {club,NOW}=await import('./hot-ops-fixture.mjs');

const scope=async(owner,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);return work(c);});
const be=postgresBackend(scope);
async function seed(owner,state){
  const {metadata,entities}=splitState(state);
  await db.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,5,$3)',[owner,JSON.stringify({...metadata,_entityStorage:1,_activityArchive:1}),new Date().toISOString()]);
  for(const e of entities)await db.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',[owner,e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);
}
const canon=x=>Array.isArray(x)?x.map(canon):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canon(x[k])])):x;
async function dump(owner){
  const rows=(await db.query('SELECT collection,entity_id,position,branch,payload FROM gymos.gym_entities WHERE owner_id=$1 ORDER BY collection,position,entity_id',[owner])).rows;
  const st=(await db.query('SELECT payload,revision FROM gymos.gym_states WHERE user_id=$1',[owner])).rows[0];
  const ev=(await db.query("SELECT revision,event_type,collection,entity_id,branch,operation,payload,actor FROM gymos.workspace_events WHERE owner_id=$1 ORDER BY revision,event_type,collection,entity_id",[owner])).rows.map(canon);
  return{rows,meta:canon(JSON.parse(st.payload)),revision:st.revision,ev};
}
const sign=(op,i)=>({id:'staff:req-'+i,digest:'dg'+i});
function ids(n){let k=0;return()=>`${n}-${k++}-aaaaaaaaaaaaaaaaaaaaaaaa`;}
async function fullRun(owner,op,i){
  const cur=await readEntitySpace(owner);const state=applyOperation(cur.state,op,NOW,'tester',ids('x'));
  state.receipts.push(sign(op,i));if(state.receipts.length>1000)state.receipts.shift();
  return persistSpace(owner,{state:cur.state,revision:cur.revision},state);
}
async function sliceRun(owner,op,i){
  const plan=hotPlan(op),hot=await readHotSlice(be,owner,plan,normalize);if(!hot)return'fallback';
  const counts=hot.counts; // read in the same revision-checked snapshot as the rows
  const state=applyHot(structuredClone(hot.state),counts,op,NOW,'tester',ids('x'));
  state.receipts.push(sign(op,i));
  return persistSpace(owner,{state:hot.state,revision:hot.revision},state,false,{positions:hot.positions,trims:[{collection:'events',keep:RECENT_EVENTS},{collection:'receipts',keep:1000}]});
}
function prep(seedNo,{events,receipts}={}){
  const s=club(seedNo);{const seen=new Set();for(const v of s.visits){if(v.leftAt)continue;if(seen.has(v.member))v.leftAt=v.at.slice(0,11)+'23:00:00.000Z';else seen.add(v.member);}}
  if(events!==undefined)s.events=Array.from({length:events},(_,i)=>({id:'ev'+i,at:'2026-03-01T00:00:00.000Z',kind:'x',subject:'s',actor:'u',branch:i%2?'a':'b'}));
  if(receipts!==undefined)s.receipts=Array.from({length:receipts},(_,i)=>({id:'u:r'+i,digest:'d'+i}));
  return s;
}
const opsFor=s=>{const o=[];for(const m of s.members.filter(m=>!m.demo)){o.push({type:'payment.add',branch:m.branch,id:m.id,minor:250,method:'cash'},{type:'visit.add',branch:m.branch,id:m.id});}for(const v of s.visits.filter(v=>!v.leftAt).slice(0,4))o.push({type:'visit.exit',branch:v.branch,id:v.id});return o;};

async function compare(label,s,op,i,exactOrder=false){
  await db.exec("DELETE FROM gymos.gym_entities WHERE owner_id IN ('F','S')");await db.exec("DELETE FROM gymos.gym_states WHERE user_id IN ('F','S')");await db.exec("DELETE FROM gymos.workspace_events WHERE owner_id IN ('F','S')");await db.exec("DELETE FROM gymos.gym_activity_archive WHERE owner_id IN ('F','S')");await db.exec("DELETE FROM gymos.workspace_outbox WHERE owner_id IN ('F','S')");
  await seed('F',s);await seed('S',s);
  let f,p;try{f=await fullRun('F',op,i);}catch(e){f='err:'+(e.code??e.message);}
  try{p=await sliceRun('S',op,i);}catch(e){p='err:'+(e.code??e.message);}
  assert.equal(p,f,`${label} outcome ${JSON.stringify(op)}`);
  if(f!==true)return f;
  const a=await dump('F'),b=await dump('S');
  assert.deepEqual(b.meta,a.meta,`${label} metadata`);assert.equal(b.revision,a.revision);
  const by=(d,c)=>d.rows.filter(r=>r.collection===c);
  for(const c of new Set([...a.rows,...b.rows].map(r=>r.collection))){
    const A=by(a,c),B=by(b,c);
    assert.deepEqual(canon(B.map(r=>[r.entity_id,r.payload,r.branch]).sort((x,y)=>x[0]<y[0]?-1:1)),canon(A.map(r=>[r.entity_id,r.payload,r.branch]).sort((x,y)=>x[0]<y[0]?-1:1)),`${label} ${c} rows`);
    if((c!=='events'&&c!=='receipts')||exactOrder)assert.deepEqual(B.map(r=>r.entity_id),A.map(r=>r.entity_id),`${label} ${c} order`);
  }
  // new rows sort after every pre-existing row of the same collection; trimmed collections keep the newest at the end
  for(const c of ['events','receipts']){const B=by(b,c);assert.equal(B.at(-1).entity_id,c==='events'?B.at(-1).entity_id:'staff:req-'+i,`${label} newest ${c} last`);}
  assert.ok(a.ev.length>0);assert.deepEqual(b.ev,a.ev,`${label} workspace_events exact delta payload parity`);
  return f;
}

test('persisted state after a hot operation matches the full path: rows, order, metadata, revision',async()=>{
  let n=0,ok=0;
  try{
    for(let seedNo=1;seedNo<=2;seedNo++){const s=prep(seedNo);const works=op=>{try{applyOperation(structuredClone(normalize(structuredClone(s))),op,NOW,'t',ids('w'));return true;}catch{return false;}};const all=opsFor(s).filter(works);for(const [i,op] of all.slice(0,6).entries()){const r=await compare('seed'+seedNo,s,op,i,true); // below the windows the full path has no position ties: order must be identical
n++;if(r===true)ok++;}}
    console.log('HOT-PERSIST cases',n,'persisted',ok);assert.ok(ok>=8,'enough persisting cases: '+ok);
  }finally{}
});
test('events window and receipts cap: oldest rows are trimmed exactly as the full path trims them',async()=>{
  const s0=prep(2,{events:RECENT_EVENTS,receipts:1000});
  const op=opsFor(s0).find(o=>o.type==='payment.add');
  // At the windows the full path's own positions tie, so the slice path refuses (full read decides) until a shared ordering fix is reviewed.
  await db.exec("DELETE FROM gymos.gym_entities WHERE owner_id='S'");await db.exec("DELETE FROM gymos.gym_states WHERE user_id='S'");await seed('S',s0);
  assert.equal(await sliceRun('S',op,7),'fallback','events/receipts at the window: slice refuses');
  let r;
  const s1=prep(2,{events:RECENT_EVENTS-1,receipts:999});r=await compare('under',s1,op,8,true);assert.equal(r,true);
  const cnt2=(await db.query("SELECT collection,count(*)::int n FROM gymos.gym_entities WHERE owner_id='S' AND collection IN ('events','receipts') GROUP BY collection ORDER BY collection")).rows;
  assert.deepEqual(cnt2.map(x=>[x.collection,x.n]),[['events',RECENT_EVENTS],['receipts',1000]]);
});

test('route helper: default-off, success matches the full path, every doubt falls back, replay and stale writers never double-apply',async()=>{
  const s=prep(1);const works=op=>{try{applyOperation(structuredClone(normalize(structuredClone(s))),op,NOW,'t',ids('w'));return true;}catch{return false;}};
  const op=opsFor(s).filter(works).find(o=>o.type==='payment.add');
  const input={owner:'S',userId:'staff',displayName:'tester',role:'owner',requestId:'req-9',digest:'dg9',revision:5,operation:op,deltaMode:true};
  await db.exec("DELETE FROM gymos.gym_entities WHERE owner_id IN ('F','S')");await db.exec("DELETE FROM gymos.gym_states WHERE user_id IN ('F','S')");await db.exec("DELETE FROM gymos.workspace_events WHERE owner_id IN ('F','S')");await db.exec("DELETE FROM gymos.gym_activity_archive WHERE owner_id IN ('F','S')");
  await seed('F',s);await seed('S',s);
  delete process.env.GYMOS_HOT_OPS;
  assert.equal(await tryHotOperation(be,input,NOW,ids('x')),null,'flag off: never runs');
  process.env.GYMOS_HOT_OPS='1';
  try{
    assert.equal(await tryHotOperation(be,{...input,deltaMode:false},NOW,ids('x')),null,'non-delta falls back');
    assert.equal(await tryHotOperation(be,{...input,revision:4},NOW,ids('x')),null,'stale revision falls back');
    assert.equal(await tryHotOperation(be,{...input,operation:{type:'member.save',branch:'a'}},NOW,ids('x')),null,'unplanned op falls back');
    assert.equal(await tryHotOperation(be,{...input,branches:['zzz']},NOW,ids('x')),null,'branch scope falls back');
    assert.equal(await tryHotOperation(be,{...input,role:'member'},NOW,ids('x')),null,'role not permitted falls back');
    // PGlite has one connection, so concurrent transactions would interleave: a true race is not provable here. Sequential stand-in: the second identical request carries the pre-write revision.
    assert.deepEqual(await tryHotOperation(be,input,NOW,ids('x')),{revision:6});
    assert.equal(await tryHotOperation(be,{...input,requestId:'req-10',digest:'dg10'},NOW,ids('y')),null,'second writer on the old revision falls back');
    assert.equal(await fullRun('F',op,9),true);
    const a=await dump('F'),b=await dump('S');
    assert.deepEqual(b.rows.filter(r=>r.collection!=='events'&&r.collection!=='receipts').map(r=>[r.collection,r.entity_id,r.payload]).sort((p,q)=>JSON.stringify(p)<JSON.stringify(q)?-1:1),a.rows.filter(r=>r.collection!=='events'&&r.collection!=='receipts').map(r=>[r.collection,r.entity_id,r.payload]).sort((p,q)=>JSON.stringify(p)<JSON.stringify(q)?-1:1),'rows equal full path');
    assert.deepEqual(b.meta,a.meta,'metadata equal');assert.equal(b.revision,a.revision);assert.deepEqual(b.ev,a.ev,'workspace_events exact parity via route helper');
    assert.equal(await tryHotOperation(be,{...input,revision:6},NOW,ids('x')),null,'replay (receipt exists) falls back to the full path');
    assert.equal((await db.query("SELECT revision FROM gymos.gym_states WHERE user_id='S'")).rows[0].revision,6,'no second write');

    // Alternating writers: slice, full, slice, full on the same club; row order and positions must stay equal to an all-full twin.
    const ops=opsFor(s).filter(works).filter(o=>o.type==='payment.add'||o.type==='visit.add').slice(1,6);
    for(const [k,o] of ops.entries()){const n=20+k;
      const full=await fullRun('F',o,n).catch(e=>'err:'+(e.code??e.message));
      const viaFull=k%2===1;
      let got;if(viaFull)got=await fullRun('S',o,n).catch(e=>'err:'+(e.code??e.message));
      else{const r=await tryHotOperation(be,{...input,operation:o,requestId:'req-'+n,digest:'dg'+n,revision:(await db.query("SELECT revision FROM gymos.gym_states WHERE user_id='S'")).rows[0].revision},NOW,ids('x'));got=r===null?await fullRun('S',o,n).catch(e=>'err:'+(e.code??e.message)):true;}
      assert.equal(got,full,'alternating outcome '+k);
    }
    const a2=await dump('F'),b2=await dump('S');
    assert.deepEqual(b2.rows.map(r=>[r.collection,r.entity_id,r.position]),a2.rows.map(r=>[r.collection,r.entity_id,r.position]),'alternating writers: same rows, same positions as all-full');
    assert.deepEqual(b2.meta,a2.meta);assert.equal(b2.revision,a2.revision);
    // Existing row missing from loaded positions: refuse, roll back, no write.
    const plan=hotPlan(op),h=await readHotSlice(be,'S',plan,normalize),st=structuredClone(h.state);st.payments.push({...st.payments[0]});const pos={...h.positions};delete pos['payments:'+st.payments[0].id];
    const before=(await db.query("SELECT revision FROM gymos.gym_states WHERE user_id='S'")).rows[0].revision;
    await assert.rejects(persistSpace('S',{state:h.state,revision:h.revision},{...st,payments:[...h.state.payments.map(x=>({...x,minor:x.minor+1}))]},false,{positions:pos,trims:[]}),e=>e.constructor.name==='SliceConflict');
    assert.equal((await db.query("SELECT revision FROM gymos.gym_states WHERE user_id='S'")).rows[0].revision,before,'rolled back');
  }finally{delete process.env.GYMOS_HOT_OPS;}
});
