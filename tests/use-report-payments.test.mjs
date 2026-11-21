import {test} from 'node:test';import assert from 'node:assert/strict';
const {pullReportPayments}=await import('../app/use-report-payments.ts');
const page=(version,n,next)=>({ok:true,json:async()=>({status:'ok',version,rows:Array.from({length:n},(_,i)=>({payment:{id:'p'+i}})),next})});
test('pull: same version answers same after one page; deadline answers tooLarge, never a truncated list',async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;return page('7',2,{day:'2026-03-01',pos:1,id:'x'});};
  assert.equal(await pullReportPayments('o','a','2026-03-01','2026-03-31',undefined,'7'),'same');assert.equal(calls,1);
  calls=0;let t=0;assert.equal(await pullReportPayments('o','a','2026-03-01','2026-03-31',undefined,undefined,1000,()=>t+=600),'tooLarge');assert.ok(calls<=3);
  globalThis.fetch=async u=>String(u).includes('after=')?page('7',1,null):page('7',2,{day:'2026-03-01',pos:1,id:'x'});
  const ok=await pullReportPayments('o','a','2026-03-01','2026-03-31');assert.equal(ok.rows.length,3);assert.equal(ok.version,'7');
  globalThis.fetch=async u=>String(u).includes('after=')?({ok:true,json:async()=>({status:'stale'})}):page('7',2,{day:'2026-03-01',pos:1,id:'x'});
  assert.equal(await pullReportPayments('o','a','2026-03-01','2026-03-31'),null); // 3 restarts exhausted -> failure state, not partial rows
  globalThis.fetch=async()=>({ok:true,json:async()=>({status:'unavailable',reason:'member-name'})});
  assert.deepEqual(await pullReportPayments('o','a','2026-03-01','2026-03-31'),{unsupported:'member-name'}); // deterministic, not a generic Retry
  globalThis.fetch=async()=>({ok:false,status:503,json:async()=>({error:'budget'})});
  assert.equal(await pullReportPayments('o','a','2026-03-01','2026-03-31'),'tooLarge');
  globalThis.fetch=async()=>({ok:false,status:500,json:async()=>({error:'server'})});
  assert.equal(await pullReportPayments('o','a','2026-03-01','2026-03-31'),null);
  globalThis.fetch=async()=>page('7',50001,{day:'2026-03-01',pos:1,id:'x'});
  assert.equal(await pullReportPayments('o','a','2026-03-01','2026-03-31'),'tooLarge'); // retained-row bound is explicit
});
