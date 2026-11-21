import {test} from 'node:test';import assert from 'node:assert/strict';import {exactPrivateCredit,PRIVATE_CREDIT_INVOICE_CAP,PRIVATE_CREDIT_BYTES,PRIVATE_CREDIT_FOLD_UNITS} from '../app/lib/member-private-credit.ts';import {memberCredit} from '../app/lib/member-ledger.ts';
const payments=[{id:'p',member:'m',branch:'a',minor:1000,creditable:true}];const c=rows=>({query:async(sql,v)=>{assert.deepEqual(v,['owner']);assert.match(sql,/owner_id=\$1/);const bytes=JSON.stringify(rows).length;return{rows:rows.length?rows.map(r=>({...r,budget_rows:rows.length,budget_bytes:bytes})): [{budget_rows:0,budget_bytes:0}]};}});
test('private scalar includes foreign allocating invoices and nonmatching fold rows, never returns them',async()=>{for(const minor of [5,'5',null,true]){const invoices=[{position:0,voided:false,allocations:[{payment:'p',minor}]},{position:1,voided:false,allocations:[]}];const out=await exactPrivateCredit(c(invoices),'owner',payments,'m','a');assert.equal(out.status,'ok');assert.equal(out.credit,memberCredit({payments,invoices},'m','a'));assert.deepEqual(Object.keys(out).sort(),['credit','status']);}});
test('refuse oversized input, ambiguous order, nonfinite money, bypass SQL for zero creditable payments',async()=>{
 assert.equal((await exactPrivateCredit(c(Array.from({length:PRIVATE_CREDIT_INVOICE_CAP+1},(_,position)=>({position}))), 'owner',payments,'m','a')).reason,'credit-invoice-cap');
 assert.equal((await exactPrivateCredit(c([{position:0,allocations:[]},{position:0,allocations:[]}]),'owner',payments,'m','a')).reason,'credit-order-ambiguous');
 assert.equal((await exactPrivateCredit(c([{position:0,allocations:[{payment:'p'}]}]),'owner',payments,'m','a')).reason,'credit-nonfinite');
 assert.deepEqual(await exactPrivateCredit({query:()=>{throw Error('unexpected SQL')}},'owner',[],'m','a'),{status:'ok',credit:0});
});

test('projection budget refuses bytes before fold and rejects malformed allocations',async()=>{
 const out=await exactPrivateCredit({query:async()=>({rows:[{budget_rows:1,budget_bytes:PRIVATE_CREDIT_BYTES+1,allocations:null}]})},'owner',payments,'m','a');assert.equal(out.reason,'credit-byte-cap');
 assert.equal((await exactPrivateCredit(c([{position:0,allocations:null}]),'owner',payments,'m','a')).reason,'credit-allocation-shape');
 assert.equal((await exactPrivateCredit(c([]),'owner',payments,'m','a')).credit,1000);
 const many=Array.from({length:2001},(_,position)=>({position,allocations:[]})),ps=Array.from({length:1000},(_,i)=>({...payments[0],id:'p'+i}));assert.equal((await exactPrivateCredit({query:async()=>({rows:many.map(r=>({...r,budget_rows:many.length,budget_bytes:1}))})},'owner',ps,'m','a')).reason,'credit-fold-cap');
});

test('fold byte work is checked before repeated legacy folds',async()=>{const ps=Array.from({length:9},(_,i)=>({...payments[0],id:'p'+i}));assert.equal((await exactPrivateCredit({query:async()=>({rows:[{budget_rows:1,budget_bytes:1048576,position:0,allocations:[],voided:false}]})},'owner',ps,'m','a')).reason,'credit-fold-byte-cap');});
