// Focused probes for the keyed-reset lint repair (member-console-history, member-visit-pager) and the
// use-dues loadMore single-flight / rapid-completion guards. jsdom + React act, no external services.
import './member-console-ui-loader.mjs';
import {test} from 'node:test';import assert from 'node:assert/strict';import {JSDOM} from 'jsdom';
const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://gymos.test',pretendToBeVisual:true});
Object.defineProperty(globalThis,'window',{value:dom.window,configurable:true});Object.defineProperty(globalThis,'document',{value:dom.window.document,configurable:true});Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});globalThis.HTMLElement=dom.window.HTMLElement;globalThis.Event=dom.window.Event;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=await import('react'),{createRoot}=await import('react-dom/client');
const h=React.createElement,root=createRoot(document.getElementById('root'));
const flush=async(ms=30)=>React.act(async()=>{await new Promise(r=>setTimeout(r,ms));});
const t=(a,b)=>a;

test('MemberConsoleHistory: switching member never paints the previous member\'s rows, not even before the new load starts',async()=>{
 const {default:MemberConsoleHistory}=await import('../app/member-console-history.tsx');
 let resolveB;const fetches=[];
 globalThis.fetch=async url=>{const m=new URL(String(url),'https://x').searchParams.get('member');fetches.push(m);
  if(m==='A')return{ok:true,json:async()=>({rows:[{id:'A1',at:'2026-11-20T10:00:00.000Z'}],next:null})};
  return new Promise(r=>{resolveB=()=>r({ok:true,json:async()=>({rows:[{id:'B1',at:'2026-11-21T11:00:00.000Z'}],next:null})});});};
 await React.act(async()=>root.render(h(MemberConsoleHistory,{member:'A',owner:'o',t})));
 await flush();
 assert.match(document.body.textContent,/2026-11-20T10:00:00\.000Z/, 'A rows visible after A load');
 // switch the prop on the SAME mounted component; B fetch stays pending
 await React.act(async()=>root.render(h(MemberConsoleHistory,{member:'B',owner:'o',t})));
 // synchronous property: the old member's rows are gone in the very commit where the prop changed
 assert.doesNotMatch(document.body.textContent,/2026-11-20T10:00:00\.000Z/,'A rows must not paint under member B');
 assert.match(document.body.textContent,/جار التحميل/,'loading shows for member B');
 await flush(); // let the new load start (fetch stays pending)
 await React.act(async()=>{resolveB();await new Promise(r=>setTimeout(r,30));});
 assert.match(document.body.textContent,/2026-11-21T11:00:00\.000Z/,'B rows visible after B load');
 assert.deepEqual(fetches,['A','B']);
});

test('MemberVisitPager: switching owner renders loading, never the old owner\'s visit list',async()=>{
 const {default:MemberVisitPager}=await import('../app/member-visit-pager.tsx');
 let resolveO2,visitCalls=0;
 globalThis.fetch=async url=>{visitCalls++;
  if(visitCalls===1)return{ok:true,json:async()=>({rows:[{id:'o1v',at:'2026-11-19T09:00:00.000Z'}],nextCursor:null})};
  return new Promise(r=>{resolveO2=()=>r({ok:true,json:async()=>({rows:[{id:'o2v',at:'2026-11-22T09:00:00.000Z'}],nextCursor:null})});});};
 await React.act(async()=>root.render(h(MemberVisitPager,{member:'m',owner:'owner-one',ar:false,timeZone:'UTC'})));
 await flush();
 const before=document.querySelector('[data-testid="visit-pager"]').textContent;
 assert.ok(before.includes('2026'),'owner-one visits visible');
 await React.act(async()=>root.render(h(MemberVisitPager,{member:'m',owner:'owner-two',ar:false,timeZone:'UTC'})));
 const during=document.querySelector('[data-testid="visit-pager"]').textContent;
 assert.notEqual(during,before,'old owner content must not paint under owner-two');
 assert.match(during,/Loading…/,'loading shows for owner-two');
 await flush(); // let the new load start (fetch stays pending)
 await React.act(async()=>{resolveO2();await new Promise(r=>setTimeout(r,30));});
 assert.match(document.querySelector('[data-testid="visit-pager"]').textContent,/2026/,'owner-two visits visible after load');
});

test('useDues loadMore is single-flight: two rapid calls fetch one page',async()=>{
 process.env.NEXT_PUBLIC_GYMOS_DUES='1';
 const {useDues}=await import('../app/use-dues.ts');
 let hook;function H(p){hook=useDues(p.active,p.state,p.owner,p.branch,p.member);return null;}
 const state={mark:'s1'},row=n=>({invoice:{id:'i'+n,member:'m',title:'t',total:100,due:'2026-12-01',branch:'b',voided:false,allocations:[]},outstanding:100,name:null,allocations:[]});
 let page2fetches=0,resolvePage2;
 globalThis.fetch=async url=>{const u=String(url);
  if(u.includes('&after=')){page2fetches++;return new Promise(r=>{resolvePage2=()=>r({ok:true,json:async()=>({status:'ok',version:'v1',rows:[row(2)],next:null})});});}
  return{ok:true,json:async()=>({status:'ok',version:'v1',total:200,rows:[row(1)],next:{pos:1,id:'i1'}})};};
 await React.act(async()=>root.render(h(H,{active:true,state,owner:'o',branch:'b',member:''})));
 await React.act(async()=>{await new Promise(r=>setTimeout(r,500));}); // initial debounce 400ms
 assert.equal(hook.view.rows.length,1,'page 1 loaded');
 await React.act(async()=>{hook.loadMore();hook.loadMore();});
 await React.act(async()=>{await new Promise(r=>setTimeout(r,50));});
 assert.equal(page2fetches,1,'single-flight: second loadMore while in flight must not fetch');
 await React.act(async()=>{resolvePage2();await new Promise(r=>setTimeout(r,30));});
 assert.equal(hook.view.rows.length,2,'page 2 appended exactly once');
});

test('useDues loadMore completion after a fresh page-1 commit restarts instead of appending onto the replaced base',async()=>{
 const {useDues}=await import('../app/use-dues.ts');
 let hook;function H(p){hook=useDues(p.active,p.state,p.owner,p.branch,p.member);return null;}
 const state={mark:'s2'},row=(n,tag)=>({invoice:{id:'i'+n+tag,member:'m',title:'t',total:100,due:'2026-12-01',branch:'b',voided:false,allocations:[]},outstanding:100,name:null,allocations:[]});
 let page1=0,resolvePage2;
 globalThis.fetch=async url=>{const u=String(url);
  if(u.includes('&after='))return new Promise(r=>{resolvePage2=()=>r({ok:true,json:async()=>({status:'ok',version:'v1',rows:[row(9,'OLD')],next:null})});});
  page1++;const v=page1===1?'v1':'v2';
  return{ok:true,json:async()=>({status:'ok',version:v,total:100,rows:[row(page1,v)],next:{pos:page1,id:'i'+page1}})};};
 await React.act(async()=>root.render(h(H,{key:'t4',active:true,state,owner:'o',branch:'b',member:''})));
 await React.act(async()=>{await new Promise(r=>setTimeout(r,500));});
 assert.equal(hook.view.rows[0].invoice.id,'i1v1','v1 page 1 loaded');
 await React.act(async()=>{hook.loadMore();}); // page-2 fetch now pending against base g (v1)
 // act defers the bump effect's re-run to scope exit and its 0ms timer to the next macrotask; flush after the scope closes
 await React.act(async()=>{hook.retry();});
 await React.act(async()=>{await new Promise(r=>setTimeout(r,100));}); // fresh page-1 (v2) refetch fires and commits underneath
 assert.equal(hook.view.rows[0].invoice.id,'i2v2','fresh page 1 committed');
 await React.act(async()=>{resolvePage2();});
 await React.act(async()=>{await new Promise(r=>setTimeout(r,100));}); // stale v1 page 2 arrives; restart refetch fires
 const ids=hook.view.rows.map(r=>r.invoice.id);
 assert.ok(!ids.includes('i9OLD'),'stale page must not append onto the replaced base');
 assert.ok(page1>=3,'restart from page 1 happened after the detected interleave');
});
