import {test,after} from 'node:test';import assert from 'node:assert/strict';import {JSDOM} from 'jsdom';
const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://gymos.test',pretendToBeVisual:true});
Object.defineProperty(globalThis,'window',{value:dom.window,configurable:true});Object.defineProperty(globalThis,'document',{value:dom.window.document,configurable:true});Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});globalThis.HTMLElement=dom.window.HTMLElement;globalThis.Event=dom.window.Event;globalThis.CustomEvent=dom.window.CustomEvent;globalThis.FormData=dom.window.FormData;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=await import('react'),{createRoot}=await import('react-dom/client'),{MemberForm}=await import('../app/member-console.tsx'),{emptyState}=await import('../app/lib/domain.ts');
globalThis.localStorage=dom.window.localStorage;globalThis.location=dom.window.location;globalThis.requestAnimationFrame=dom.window.requestAnimationFrame.bind(dom.window);globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame.bind(dom.window);dom.window.scrollTo=()=>{};
const h=React.createElement,root=createRoot(document.getElementById('root'));let calls=[];

const props={state:emptyState(),branch:'main',owner:'owner',actor:'admin',role:'owner',busy:false,mutate:async o=>{calls.push(o);return true;},reload:async()=>{},done(){}};
const field=text=>Array.from(document.querySelectorAll('label')).find(e=>e.textContent.startsWith(text))?.querySelector('input');
async function change(input,value){await React.act(async()=>{Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new dom.window.Event('input',{bubbles:true}));});}
after(async()=>{await React.act(async()=>root.unmount());dom.window.close();setTimeout(()=>process.exit(0),200);});
const {applyOperation}=await import('../app/lib/domain.ts');
const {randomUUID}=await import('node:crypto');
const nowIso=new Date().toISOString();
const op=(s,type,extra={})=>applyOperation(s,{type,branch:'main',...extra},nowIso,'QA',randomUUID);
function build(legacy=false){let s=op(emptyState(),'member.save',{name:'عضو اختبار كامل',phone:'',joined:nowIso.slice(0,10),expires:nowIso.slice(0,10)});s=op(s,'plan.save',{name:'باقة اختبار',days:30,visits:null,minor:10000});const id=s.members[0].id,plan=s.plans[0].id,d=nowIso.slice(0,10);s=op(s,'plan.assign',{id,plan,start:d,due:d,paid:0,method:'cash',startMode:'replaceCurrent',confirmReplace:true});s=op(s,'plan.assign',{id,plan,start:d,due:d,paid:0,method:'cash'});if(legacy)delete s.members[0].membershipPeriods.at(-1).invoice;return s;}
const click=async el=>{await React.act(async()=>el.click());};
const btn=text=>Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()===text);
async function openRenew(ar,state){calls=[];const {MemberConsoleDetails}=await import('../app/member-console.tsx');await React.act(async()=>root.render(h(MemberConsoleDetails,{...props,ar,state,member:state.members[0],serverNow:Date.now(),key:'pc-'+ar+Math.random()})));await click(btn(ar?'تجديد الاشتراك':'Renew subscription'));}
for(const ar of [true,false]){
test('Future-term cancel action renders and sends one confirmed reasoned period.cancel ('+(ar?'AR':'EN')+')',async()=>{const state=build();await openRenew(ar,state);const open=btn(ar?'إلغاء هذه الفترة المستقبلية':'Cancel this future term');assert.ok(open,document.body.textContent.slice(0,600));assert.match(document.body.textContent,ar?/لا يحذف أي دفعة/:/no payment is removed/);await click(open);const confirm=btn(ar?'تأكيد إلغاء الفترة':'Confirm cancellation');assert.ok(confirm);assert.equal(confirm.disabled,true);await change(field(ar?'سبب الإلغاء':'Reason'),'تجديد بالخطأ');assert.equal(confirm.disabled,false);await React.act(async()=>confirm.closest('form').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true})));assert.equal(calls.length,1);assert.equal(calls[0].type,'period.cancel');assert.equal(calls[0].reason,'تجديد بالخطأ');assert.equal(calls[0].period,state.members[0].membershipPeriods.at(-1).id);assert.equal(calls[0].id,state.members[0].id);});
test('Legacy term without invoice link offers no cancel action ('+(ar?'AR':'EN')+')',async()=>{await openRenew(ar,build(true));assert.equal(btn(ar?'إلغاء هذه الفترة المستقبلية':'Cancel this future term'),undefined);});
}
