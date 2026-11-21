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
});
