import {test} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {emptyState,applyOperation,dayAt} from '../app/lib/domain.ts';
const now='2026-10-25T10:00:00Z';
const op=(s,type,data={},at=now)=>applyOperation(s,{type,branch:'main',...data},at,'QA manager',randomUUID);
function setup(){
 let s=emptyState();
 s=op(s,'shop.supplier.save',{name:'Synthetic supplier'});
 s=op(s,'shop.product.save',{name:'Synthetic item',sku:'QA-FIN-1',category:'protein',price:2000,lowStock:2});
 s=op(s,'hr.employee.save',{name:'Synthetic staff',job:'Coach',phone:'',base:500000,allowance:0,annualLeave:20,contractStart:'2026-01-01'});
 s=op(s,'hr.payroll.generate',{employee:s.hr.employees[0].id,month:'2026-10'});
 return s;
}
const purchase=(s,reference)=>({supplier:s.suppliers[0].id,reference,due:'2026-11-01',paid:0,method:'transfer',lines:[{product:s.products[0].id,quantity:2,cost:100,batch:'QA',expires:'2027-01-01'}]});

test('Closed cash day rejects expense, purchase, supplier payment and payroll writes',()=>{
 let s=setup();
 s=op(s,'book.purchase.add',purchase(s,'BEFORE-CLOSE'));
 const day=dayAt(now,s.settings.timezone);
 s=op(s,'finance.close',{day,actual:0,note:'Synthetic close'});
 const closures=structuredClone(s.cashClosures);
 const attempts=[
  ['book.expense.add',{title:'After close',category:'other',minor:500,method:'cash',day}],
  ['book.purchase.add',purchase(s,'AFTER-CLOSE')],
  ['book.supplier.pay',{id:s.financeBook.purchases[0].id,minor:50,method:'cash'}],
  ['hr.payroll.pay',{id:s.hr.payroll[0].id,method:'cash'}],
 ];
 for(const [type,data] of attempts){
  const before=JSON.stringify(s);
  assert.throws(()=>op(s,type,data),/transition/,type);
  assert.equal(JSON.stringify(s),before,type+' must leave state untouched');
 }
 assert.deepEqual(s.cashClosures,closures);
 assert.equal(s.financeBook.expenses.length,0);
 assert.equal(s.financeBook.supplierPayments.length,0);
 assert.equal(s.hr.payroll[0].status,'draft');
});

test('Money writes before a cash closure still succeed',()=>{
 let s=setup(),day=dayAt(now,s.settings.timezone);
 s=op(s,'book.expense.add',{title:'Before close',category:'other',minor:500,method:'cash',day});
 s=op(s,'book.purchase.add',purchase(s,'VALID-WRITE'));
 s=op(s,'book.supplier.pay',{id:s.financeBook.purchases[0].id,minor:50,method:'cash'});
 s=op(s,'hr.payroll.pay',{id:s.hr.payroll[0].id,method:'cash'});
 assert.equal(s.financeBook.expenses.length,2);
 assert.equal(s.financeBook.expenses[0].day,day);
 assert.equal(s.financeBook.purchases.length,1);
 assert.equal(s.financeBook.supplierPayments.length,1);
 assert.equal(s.financeBook.purchases[0].id,s.financeBook.supplierPayments[0].purchase);
 assert.equal(s.hr.payroll[0].status,'paid');
 assert.equal(s.cashClosures?.length??0,0);
});

test('A closure on another day does not block the current cash day',()=>{
 let s=setup();
 s=op(s,'finance.close',{day:'2026-10-24',actual:0,note:'Different day'});
 s=op(s,'book.expense.add',{title:'Today',category:'other',minor:300,method:'cash',day:dayAt(now,s.settings.timezone)});
 assert.equal(s.financeBook.expenses.length,1);
 assert.equal(s.cashClosures.length,1);
});
