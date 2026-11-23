import {test} from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {emptyState,applyOperation,dayAt} from '../app/lib/domain.ts';
import {dailyBookOutflow} from '../app/lib/finance-book.ts';
import {buildReport} from '../app/lib/full-report.ts';
const now='2026-10-25T22:30:00Z'; // 2026-10-26 in the club's Africa/Cairo timezone
const op=(s,type,data={},at=now)=>applyOperation(s,{type,branch:'main',...data},at,'QA manager',randomUUID);
function state(){let s=emptyState();return op(s,'member.save',{name:'Synthetic',phone:'',joined:'2026-10-01',expires:'2026-12-01'});}
const expenseRows=report=>report.tables.find(t=>t.key==='operating_expenses').rows;
const summary=label=>report=>report.tables[0].rows.find(row=>row[0]===label)?.[1];

test('Backdated cash expense shares one authoritative day across record, outflow, report and ledger',()=>{
 let s=state(),day=dayAt(now,s.settings.timezone);
 assert.equal(day,'2026-10-26');
 s=op(s,'book.expense.add',{title:'Backdated utility',category:'utilities',minor:1200,method:'cash',day:'2026-10-25'});
 const expense=s.financeBook.expenses[0];
 assert.equal(expense.day,day);
 assert.equal(expense.at,now);
 assert.equal(dailyBookOutflow(s,'main',day),1200);
 assert.equal(dailyBookOutflow(s,'main','2026-10-25'),0);
 const movement=s.financeBook.movements.find(m=>m.source==='expense:'+expense.id);
 assert.ok(movement);
 assert.equal(dayAt(movement.at,s.settings.timezone),day);
 const report=buildReport(s,['main'],day,day,false,now);
 assert.equal(expenseRows(report).length,1);
 assert.equal(expenseRows(report)[0][2],day);
 assert.equal(summary('Recorded operating expenses')(report),12);
 assert.equal(expenseRows(buildReport(s,['main'],'2026-10-25','2026-10-25',false,now)).length,0);
});

test('Cash closure expected total follows the timestamp day of a backdated expense',()=>{
 let s=state();
 s=op(s,'payment.add',{id:s.members[0].id,minor:10000,method:'cash'});
 s=op(s,'book.expense.add',{title:'Backdated rent',category:'rent',minor:1500,method:'cash',day:'2026-10-25'});
 const day=dayAt(now,s.settings.timezone);
 s=op(s,'finance.close',{day,actual:8500,note:''});
 assert.equal(dailyBookOutflow(s,'main',day),1500);
 assert.equal(s.cashClosures[0].day,day);
 assert.equal(s.cashClosures[0].expected,8500);
});

test('Future days are rejected against the timestamp day in the club timezone',()=>{
 const s=state();
 assert.throws(()=>op(s,'book.expense.add',{title:'Future',category:'other',minor:100,method:'cash',day:'2026-10-27'}),/dates/);
 assert.doesNotThrow(()=>op(s,'book.expense.add',{title:'Today in Cairo',category:'other',minor:100,method:'cash',day:'2026-10-26'}));
});

test('Legacy expense with a divergent stored day is read by its timestamp day',()=>{
 let s=state(),day=dayAt(now,s.settings.timezone);
 s=op(s,'book.expense.add',{title:'Legacy',category:'other',minor:700,method:'cash',day});
 s.financeBook.expenses[0].day='2026-10-01';
 assert.equal(dailyBookOutflow(s,'main',day),700);
 assert.equal(dailyBookOutflow(s,'main','2026-10-01'),0);
 const report=buildReport(s,['main'],day,day,false,now);
 assert.equal(expenseRows(report).length,1);
 assert.equal(expenseRows(report)[0][2],day);
});
