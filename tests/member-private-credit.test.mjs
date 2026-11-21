import {test} from 'node:test';import assert from 'node:assert/strict';import {exactPrivateCredit,PRIVATE_CREDIT_INVOICE_CAP} from '../app/lib/member-private-credit.ts';import {memberCredit} from '../app/lib/member-ledger.ts';
const payments=[{id:'p',member:'m',branch:'a',minor:1000,creditable:true}];const c=rows=>({query:async(sql,v)=>{assert.deepEqual(v,['owner']);assert.match(sql,/owner_id=\$1/);return{rows};}});
test('private scalar includes foreign allocating invoices and nonmatching fold rows, never returns them',async()=>{for(const minor of [5,'5',null,true]){const invoices=[{position:0,voided:false,allocations:[{payment:'p',minor}]},{position:1,voided:false,allocations:[]}];const out=await exactPrivateCredit(c(invoices),'owner',payments,'m','a');assert.equal(out.status,'ok');assert.equal(out.credit,memberCredit({payments,invoices},'m','a'));assert.deepEqual(Object.keys(out).sort(),['credit','status']);}});
test('refuse oversized input, ambiguous order, nonfinite money, bypass SQL for zero creditable payments',async()=>{
 assert.equal((await exactPrivateCredit(c(Array.from({length:PRIVATE_CREDIT_INVOICE_CAP+1},(_,position)=>({position}))), 'owner',payments,'m','a')).reason,'credit-invoice-cap');
 assert.equal((await exactPrivateCredit(c([{position:0},{position:0}]),'owner',payments,'m','a')).reason,'credit-order-ambiguous');
 assert.equal((await exactPrivateCredit(c([{position:0,allocations:[{payment:'p'}]}]),'owner',payments,'m','a')).reason,'credit-nonfinite');
 assert.deepEqual(await exactPrivateCredit({query:()=>{throw Error('unexpected SQL')}},'owner',[],'m','a'),{status:'ok',credit:0});
});
