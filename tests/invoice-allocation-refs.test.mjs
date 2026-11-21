import {test,after} from 'node:test';import assert from 'node:assert/strict';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const db=await bootstrapDb();after(()=>db.close());
const ins=(o,id,pos,br,payload)=>db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,'invoices',$2,$3,$4,$5)",[o,id,pos,br,JSON.stringify(payload)]);
// oracle: the legacy loop's view of one payment id: for each invoice in (position, entity_id) order, its elements whose payment === id (objects only), in source order, minor raw
function legacy(rows,owner,pid){return rows.filter(r=>r.o===owner).sort((a,b)=>a.pos-b.pos||(a.id<b.id?-1:1)).map(r=>({id:r.id,els:(Array.isArray(r.p.allocations)?r.p.allocations:[]).filter(a=>a&&typeof a==='object'&&!Array.isArray(a)&&a.payment===pid).map(a=>({payment:a.payment,...('minor' in a?{minor:a.minor}:{})}))})).filter(x=>x.els.length);}
async function viaRefs(owner,pid){const r=(await db.query("SELECT invoice_id,invoice_position,ord,has_minor,minor,payment_id FROM gymos.invoice_allocation_refs WHERE owner_id=$1 AND payment_key=md5($2) AND payment_id=$2 ORDER BY invoice_position,invoice_id,ord",[owner,pid])).rows;const m=new Map();for(const x of r){if(!m.has(x.invoice_id))m.set(x.invoice_id,[]);m.get(x.invoice_id).push({payment:x.payment_id,...(x.has_minor?{minor:x.minor}:{})});}return [...m].map(([id,els])=>({id,els}));}
test('refs mirror the legacy per-payment element sequence through insert/update/delete/key change/truncate, odd shapes and oversized ids',async()=>{
  const rows=[];let sd=7;const rnd=()=>{sd=(sd*1664525+1013904223)>>>0;return sd/2**32;};const pick=a=>a[Math.floor(rnd()*a.length)];
  const big='x'.repeat(5000);
  const mkAlloc=()=>pick([{payment:'p1',minor:100},{payment:'p2',minor:null},{payment:'p1'},{payment:'p3',minor:0.5,note:'n'},{payment:7,minor:1},{payment:null},null,5,'s',[1],{minor:1},{payment:big,minor:2},{payment:'p1',minor:-3}]);
  for(let i=0;i<60;i++){const o=pick(['A','B']),alloc=pick([undefined,null,'str',{a:1},[],Array.from({length:Math.floor(rnd()*6)},mkAlloc)]);const p={id:'i'+i,...(alloc!==undefined?{allocations:alloc}:{})};const pos=Math.floor(rnd()*10),id='i'+i;rows.push({o,id,pos,p});await db.query("SELECT set_config('app.gym_owner',$1,false)",[o]);await ins(o,id,pos,pick(['a','b']),p);}
  const check=async()=>{for(const o of ['A','B'])for(const pid of ['p1','p2','p3','p9',big,'7','s'])assert.deepEqual(await viaRefs(o,pid),legacy(rows,o,pid),o+pid.slice(0,3));};
  await check();
  // update allocations / position
  for(const r of rows.slice(0,25)){r.p={...r.p,allocations:[mkAlloc(),mkAlloc()]};r.pos=Math.floor(rnd()*10);await db.query("UPDATE gymos.gym_entities SET payload=$3,position=$4 WHERE owner_id=$1 AND collection='invoices' AND entity_id=$2",[r.o,r.id,JSON.stringify(r.p),r.pos]);}
  await check();
  // an update that touches nothing relevant keeps the refs
  await db.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{note}','\"x\"') WHERE collection='invoices'");for(const r of rows)r.p={...r.p,note:'x'};await check();
  // delete
  for(const r of rows.splice(30,10))await db.query("DELETE FROM gymos.gym_entities WHERE owner_id=$1 AND collection='invoices' AND entity_id=$2",[r.o,r.id]);await check();
  assert.equal(Number((await db.query("SELECT gymos.invoice_allocation_refs_mismatches('A') + gymos.invoice_allocation_refs_mismatches('B') AS n")).rows[0].n),0);
  // odd table: exactly the invoices with a non-array allocations or a skipped element
  const odd=new Set((await db.query("SELECT owner_id||'/'||invoice_id k FROM gymos.invoice_allocation_odd")).rows.map(x=>x.k));
  const expOdd=new Set(rows.filter(r=>{const a=r.p.allocations;if(!Array.isArray(a))return true;return a.some(e=>!(e&&typeof e==='object'&&!Array.isArray(e)&&typeof e.payment==='string'));}).map(r=>r.o+'/'+r.id));
  assert.deepEqual([...odd].sort(),[...expOdd].sort());
  // actual ledger functions (not a normalizing oracle): every invoice on which the real code throws must be marked odd
  const {paymentAvailable,invoiceOutstanding,paymentBreakdown}=await import('../app/lib/member-ledger.ts');
  let thrown=0;for(const r of rows){const inv={id:r.id,member:'m',branch:'a',total:10,voided:false,allocations:r.p.allocations};const pay={id:'p1',member:'m',branch:'a',minor:100,voided:false};
    let threw=false;for(const f of [()=>paymentAvailable({payments:[pay],invoices:[inv]},pay),()=>invoiceOutstanding({payments:[pay],invoices:[inv]},inv),()=>paymentBreakdown({payments:[pay],invoices:[inv]},pay)]){try{f();}catch{threw=true;}}
    if(threw){thrown++;assert.ok(odd.has(r.o+'/'+r.id),'real ledger throws but invoice not odd: '+r.id);}}
  assert.ok(thrown>0);
  // corrupt a ref: verification sees it, rebuild (batched) repairs it, 0 mismatches again
  await db.query("DELETE FROM gymos.invoice_allocation_refs WHERE owner_id='A' AND ctid IN (SELECT ctid FROM gymos.invoice_allocation_refs WHERE owner_id='A' LIMIT 1)");
  assert.ok(Number((await db.query("SELECT gymos.invoice_allocation_refs_mismatches('A') n")).rows[0].n)>=1);
  let after=null;do{after=(await db.query("SELECT gymos.invoice_allocation_refs_rebuild('A',$1,7) a",[after])).rows[0].a;}while(after!==null);
  assert.equal(Number((await db.query("SELECT gymos.invoice_allocation_refs_mismatches('A') n")).rows[0].n),0);await check();
  // moving an invoice row OUT of the collection removes its refs and odd rows; moving a row INTO it adds them
  {const o='A',id='mv1';await ins(o,id,1,'a',{id,allocations:[{payment:'p1',minor:1},5]});
   const cnt=async()=>[Number((await db.query("SELECT count(*) n FROM gymos.invoice_allocation_refs WHERE owner_id='A' AND invoice_id='mv1'")).rows[0].n),Number((await db.query("SELECT count(*) n FROM gymos.invoice_allocation_odd WHERE owner_id='A' AND invoice_id='mv1'")).rows[0].n)];
   assert.deepEqual(await cnt(),[1,1]);
   await db.query("UPDATE gymos.gym_entities SET collection='members' WHERE owner_id='A' AND collection='invoices' AND entity_id='mv1'");assert.deepEqual(await cnt(),[0,0]);
   await db.query("UPDATE gymos.gym_entities SET collection='invoices' WHERE owner_id='A' AND collection='members' AND entity_id='mv1'");assert.deepEqual(await cnt(),[1,1]);
   await db.query("DELETE FROM gymos.gym_entities WHERE owner_id='A' AND entity_id='mv1'");assert.deepEqual(await cnt(),[0,0]);
   assert.equal(Number((await db.query("SELECT gymos.invoice_allocation_refs_mismatches('A') n")).rows[0].n),0);}
  // key change (entity id) and truncate
  const r0=rows[0];await db.query("UPDATE gymos.gym_entities SET entity_id='renamed' WHERE owner_id=$1 AND collection='invoices' AND entity_id=$2",[r0.o,r0.id]);r0.id='renamed';await check();
  await db.query("TRUNCATE gymos.gym_entities");assert.equal(Number((await db.query("SELECT count(*) n FROM gymos.invoice_allocation_refs")).rows[0].n),0);
});
test('payment day key columns: canonical day in pay_day, every other payments row flagged odd',async()=>{
  await db.query("TRUNCATE gymos.gym_entities");
  const add=(id,day)=>db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES('A','payments',$1,1,'a',$2)",[id,JSON.stringify(day===undefined?{id}:{id,day})]);
  await add('ok','2026-03-05');await add('n',20260305);await add('bad','2026-3-5');await add('none');
  const r=(await db.query("SELECT entity_id,pay_day,pay_day_odd FROM gymos.gym_entities ORDER BY entity_id")).rows;
  assert.deepEqual(r,[{entity_id:'bad',pay_day:null,pay_day_odd:true},{entity_id:'n',pay_day:null,pay_day_odd:true},{entity_id:'none',pay_day:null,pay_day_odd:true},{entity_id:'ok',pay_day:'2026-03-05',pay_day_odd:false}]);
});
test('runtime role cannot write derived tables, claim readiness or call maintenance; trigger-only maintenance still works as runtime; epoch change clears readiness',async()=>{
  const q=s=>db.query(s);
  await q("DELETE FROM gymos.gym_entities");await q("DELETE FROM gymos.gym_states");
  const role=(await q("SELECT rolsuper,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname='gymos_refs_maint'")).rows[0];assert.deepEqual(role,{rolsuper:false,rolbypassrls:false,rolcanlogin:false});
  await q("INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES('RT','{}',1,'x')");
  await q("SET ROLE gymos_app");await q("SELECT set_config('app.gym_owner','RT',false)");
  try{
    await q("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES('RT','invoices','i1',1,'a','{\"allocations\":[{\"payment\":\"p\",\"minor\":1}]}')");
    const cnt=async t=>Number((await q("SELECT count(*) n FROM gymos."+t)).rows[0].n);
    assert.equal(await cnt('invoice_allocation_refs'),1);assert.equal(await cnt('invoice_allocation_refs_state'),0);
    const denied=async(sql)=>{await q("BEGIN");let ok=false;try{await q(sql);ok=true;}catch(e){assert.match(String(e.message),/permission denied|row-level security|must be owner|not allowed/i,sql);}await q("ROLLBACK");assert.ok(!ok,'runtime must be denied: '+sql);};
    await denied("INSERT INTO gymos.invoice_allocation_refs VALUES('RT','i1',9,'p',md5('p'),true,'1',1,'a')");
    await denied("DELETE FROM gymos.invoice_allocation_refs");
    await denied("UPDATE gymos.invoice_allocation_refs SET invoice_position=9");
    await denied("TRUNCATE gymos.invoice_allocation_refs");
    await denied("INSERT INTO gymos.invoice_allocation_odd VALUES('RT','i1',1,'a')");
    await denied("DELETE FROM gymos.invoice_allocation_refs_state");
    await denied("INSERT INTO gymos.invoice_allocation_refs_state(owner_id) VALUES('RT2')");
    await denied("SELECT gymos.invoice_allocation_refs_sync()");
    await denied("SELECT gymos.invoice_allocation_refs_complete('RT',(SELECT ((payload::jsonb)->'generation')::text FROM gymos.gym_states WHERE user_id='RT'))");
    await denied("SELECT gymos.invoice_allocation_refs_rebuild('RT',NULL,10)");
    await denied("SELECT gymos.invoice_allocation_refs_mismatches('RT')");
    await denied("ALTER TABLE gymos.invoice_allocation_refs DISABLE ROW LEVEL SECURITY");
    await denied("ALTER TABLE gymos.gym_entities DISABLE TRIGGER invoice_allocation_refs_upd");
    // owner isolation for reads
    await q("SELECT set_config('app.gym_owner','OTHER',false)");assert.equal(await cnt('invoice_allocation_refs'),0);await q("SELECT set_config('app.gym_owner','RT',false)");
    // legitimate runtime update/delete keeps refs exact through the maintenance trigger
    await q("UPDATE gymos.gym_entities SET payload='{\"allocations\":[{\"payment\":\"p\"},{\"payment\":\"q\"}]}' WHERE owner_id='RT' AND entity_id='i1'");assert.equal(await cnt('invoice_allocation_refs'),2);
    await q("DELETE FROM gymos.gym_entities WHERE owner_id='RT'");assert.equal(await cnt('invoice_allocation_refs'),0);
  }finally{await q("RESET ROLE");}
  await q("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES('RT','invoices','k',1,'a','{\"allocations\":[]}')");
  assert.equal((await q("SELECT gymos.invoice_allocation_refs_complete('RT',(SELECT ((payload::jsonb)->'generation')::text FROM gymos.gym_states WHERE user_id='RT')) x")).rows[0].x,true); // migration-authorized readiness
  // epoch change (no invoice diff) removes readiness; unrelated metadata change does not
  assert.equal(Number((await q("SELECT count(*) n FROM gymos.invoice_allocation_refs_state WHERE ready AND owner_id='RT'")).rows[0].n),1);
  await q("UPDATE gymos.gym_states SET payload='{\"other\":1}',revision=2 WHERE user_id='RT'");assert.equal(Number((await q("SELECT count(*) n FROM gymos.invoice_allocation_refs_state WHERE ready AND owner_id='RT'")).rows[0].n),1);
  await q("UPDATE gymos.gym_states SET payload='{\"generation\":\"e1\"}',revision=3 WHERE user_id='RT'");assert.equal(Number((await q("SELECT count(*) n FROM gymos.invoice_allocation_refs_state WHERE ready AND owner_id='RT'")).rows[0].n),0);
  assert.equal((await q("SELECT gymos.invoice_allocation_refs_complete('RT',(SELECT ((payload::jsonb)->'generation')::text FROM gymos.gym_states WHERE user_id='RT')) x")).rows[0].x,true);
  // same generation again keeps readiness; invalid metadata text and a type change fail closed
  const rdy=async()=>Number((await q("SELECT count(*) n FROM gymos.invoice_allocation_refs_state WHERE ready AND owner_id='RT'")).rows[0].n);
  await q("UPDATE gymos.gym_states SET payload='{\"generation\":\"e1\",\"x\":2}',revision=4 WHERE user_id='RT'");assert.equal(await rdy(),1);
  await q("UPDATE gymos.gym_states SET payload='{\"generation\":5}',revision=5 WHERE user_id='RT'");assert.equal(await rdy(),0);
  await q("SELECT gymos.invoice_allocation_refs_complete('RT',(SELECT ((payload::jsonb)->'generation')::text FROM gymos.gym_states WHERE user_id='RT'))");await q("UPDATE gymos.gym_states SET payload='not json',revision=6 WHERE user_id='RT'");assert.equal(await rdy(),0);
  assert.equal((await q("SELECT gymos.invoice_allocation_refs_complete('RT',NULL) x")).rows[0].x,false);assert.equal(await rdy(),0);await q("UPDATE gymos.gym_states SET payload='{}',revision=7 WHERE user_id='RT'");assert.equal((await q("SELECT gymos.invoice_allocation_refs_complete('RT',NULL) x")).rows[0].x,true);assert.equal(await rdy(),1);
  await q("DELETE FROM gymos.gym_states WHERE user_id='RT'");assert.equal(Number((await q("SELECT count(*) n FROM gymos.invoice_allocation_refs_state WHERE ready")).rows[0].n),0);
});
test('invalidated readiness is a tombstone: no first-invoice auto-ready after generation change, delete/reinsert, empty restored owner, rollback',async()=>{
  const q=s=>db.query(s);const ready=async o=>(await q("SELECT ready FROM gymos.invoice_allocation_refs_state WHERE owner_id='"+o+"'")).rows[0]?.ready;
  await q("DELETE FROM gymos.gym_entities");await q("DELETE FROM gymos.gym_states");await q("DELETE FROM gymos.invoice_allocation_refs_state");
  const inv=(o,id)=>q("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES('"+o+"','invoices','"+id+"',1,'a','{\"allocations\":[{\"payment\":\"p\"}]}')");
  await q("INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES('T1','{}',1,'x')");
  await inv('T1','a');assert.equal(await ready('T1'),undefined); // no automatic claim, even for a brand new owner
  assert.equal((await q("SELECT gymos.invoice_allocation_refs_complete('T1',(SELECT ((payload::jsonb)->'generation')::text FROM gymos.gym_states WHERE user_id='T1')) x")).rows[0].x,true);assert.equal(await ready('T1'),true);
  await q("UPDATE gymos.gym_states SET payload='{\"generation\":\"g1\"}',revision=2 WHERE user_id='T1'");assert.equal(await ready('T1'),false);
  // delete the only invoice, then reinsert: tombstone blocks the shortcut
  await q("DELETE FROM gymos.gym_entities WHERE owner_id='T1'");await inv('T1','b');assert.equal(await ready('T1'),false);
  // empty restored owner, then first invoice: still tombstoned
  await q("DELETE FROM gymos.gym_entities WHERE owner_id='T1'");await q("UPDATE gymos.gym_states SET payload='{\"generation\":\"g2\"}',revision=3 WHERE user_id='T1'");await inv('T1','c');assert.equal(await ready('T1'),false);
  // only the migration-authorized complete() restores readiness
  assert.equal((await q("SELECT gymos.invoice_allocation_refs_complete('T1',(SELECT ((payload::jsonb)->'generation')::text FROM gymos.gym_states WHERE user_id='T1')) x")).rows[0].x,true);assert.equal(await ready('T1'),true);
  // rollback: a restore transaction that fails leaves readiness untouched
  await q("BEGIN");await q("UPDATE gymos.gym_states SET payload='{\"generation\":\"g3\"}',revision=4 WHERE user_id='T1'");assert.equal(await ready('T1'),false);await q("ROLLBACK");assert.equal(await ready('T1'),true);
  // an owner with stale refs but no state row: a new first invoice never claims readiness
  await q("DELETE FROM gymos.invoice_allocation_refs_state WHERE owner_id='T1'");await q("DELETE FROM gymos.gym_entities WHERE owner_id='T1'");
  await q("INSERT INTO gymos.invoice_allocation_refs VALUES('T1','ghost',0,'p',md5('p'),false,NULL,1,'a')");await inv('T1','d');assert.equal(await ready('T1'),undefined);
  await q("DELETE FROM gymos.invoice_allocation_refs WHERE owner_id='T1' AND invoice_id='ghost'");
});
test('mismatches() depends only on its own owner (same entity id across owners/collections/branches) and sees orphan odd rows',async()=>{
  const q=s=>db.query(s);const mm=async o=>Number((await q("SELECT gymos.invoice_allocation_refs_mismatches('"+o+"') n")).rows[0].n);
  await q("DELETE FROM gymos.gym_entities");await q("DELETE FROM gymos.invoice_allocation_odd");
  await q("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES('XA','invoices','x',1,'a','{\"allocations\":null}'),('XB','invoices','x',1,'b','{\"allocations\":[]}'),('XA','members','x',1,'a','{}'),('XB','members','x',1,'b','{}')");
  assert.equal(await mm('XA'),0);assert.equal(await mm('XB'),0);
  await q("DELETE FROM gymos.gym_entities WHERE owner_id='XB'");assert.equal(await mm('XA'),0);assert.equal(await mm('XB'),0);
  await q("INSERT INTO gymos.invoice_allocation_odd VALUES('XA','ghost',1,'a')");assert.equal(await mm('XA'),1);assert.equal(await mm('XB'),0);
  await q("DELETE FROM gymos.invoice_allocation_odd WHERE invoice_id='ghost'");assert.equal(await mm('XA'),0);
});
test('a pre-existing maintenance role is rejected unless exactly safe (re-running the preflight fails closed)',async()=>{
  const sql=(await import('node:fs')).readFileSync(new URL('../supabase/migrations/20261122030000_invoice_allocation_refs.sql',import.meta.url),'utf8');
  const pre=sql.slice(sql.indexOf('DO $r$'),sql.indexOf('END $r$;')+8);
  const run=()=>db.exec(pre);
  await run(); // our own role passes
  const bad=async(setup,undo,re)=>{await db.exec(setup);try{await assert.rejects(run,re);}finally{await db.exec(undo);}};
  await bad("ALTER ROLE gymos_refs_maint LOGIN","ALTER ROLE gymos_refs_maint NOLOGIN",/unsafe attributes/);
  await bad("ALTER ROLE gymos_refs_maint INHERIT","ALTER ROLE gymos_refs_maint NOINHERIT",/unsafe attributes/);
  await bad("ALTER ROLE gymos_refs_maint CREATEDB","ALTER ROLE gymos_refs_maint NOCREATEDB",/unsafe attributes/);
  await bad("CREATE ROLE rr_member; GRANT rr_member TO gymos_refs_maint","REVOKE rr_member FROM gymos_refs_maint; DROP ROLE rr_member",/memberships/);
  await bad("GRANT gymos_refs_maint TO gymos_app","REVOKE gymos_refs_maint FROM gymos_app",/memberships/);
  await bad("CREATE TABLE gymos.rr_owned(a int); ALTER TABLE gymos.rr_owned OWNER TO gymos_refs_maint","DROP TABLE gymos.rr_owned",/unrelated ownership/);
  await bad("CREATE TABLE gymos.rr_priv(a int); GRANT SELECT ON gymos.rr_priv TO gymos_refs_maint","DROP TABLE gymos.rr_priv",/unrelated ownership or privileges/);
  await run();
});
