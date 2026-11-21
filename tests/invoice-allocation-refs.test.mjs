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
  const expOdd=new Set(rows.filter(r=>{const a=r.p.allocations;if(a===undefined||a===null)return false;if(!Array.isArray(a))return true;return a.some(e=>!(e&&typeof e==='object'&&!Array.isArray(e)&&typeof e.payment==='string'));}).map(r=>r.o+'/'+r.id));
  assert.deepEqual([...odd].sort(),[...expOdd].sort());
  // corrupt a ref: verification sees it, rebuild (batched) repairs it, 0 mismatches again
  await db.query("DELETE FROM gymos.invoice_allocation_refs WHERE owner_id='A' AND ctid IN (SELECT ctid FROM gymos.invoice_allocation_refs WHERE owner_id='A' LIMIT 1)");
  assert.ok(Number((await db.query("SELECT gymos.invoice_allocation_refs_mismatches('A') n")).rows[0].n)>=1);
  let after=null;do{after=(await db.query("SELECT gymos.invoice_allocation_refs_rebuild('A',$1,7) a",[after])).rows[0].a;}while(after!==null);
  assert.equal(Number((await db.query("SELECT gymos.invoice_allocation_refs_mismatches('A') n")).rows[0].n),0);await check();
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
