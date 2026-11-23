import {test} from 'node:test';import assert from 'node:assert/strict';import {JSDOM} from 'jsdom';
const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://gymos.test',pretendToBeVisual:true});
Object.defineProperty(globalThis,'window',{value:dom.window,configurable:true});Object.defineProperty(globalThis,'document',{value:dom.window.document,configurable:true});Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
globalThis.localStorage=dom.window.localStorage;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=await import('react'),{createRoot}=await import('react-dom/client'),{default:NotificationCenter}=await import('../app/notification-center.tsx');
const h=React.createElement,root=createRoot(document.getElementById('root'));
const props={scope:'s',branch:'north',ar:true,proposals:[],errors:[],onOpenPulse(){},onOpenCommunity(){}};
async function render(result){globalThis.__permResult=result;await React.act(async()=>root.render(h(NotificationCenter,{...props,key:Math.random()})));const bell=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')?.includes('إشعار')||b.getAttribute('aria-label')?.includes('notification'));await React.act(async()=>bell.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true})));const enable=[...document.querySelectorAll('button')].find(b=>b.textContent==='تفعيل تنبيهات الرسائل');assert.ok(enable,'enable-alerts button must render');await React.act(async()=>enable.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true})));return document.querySelector('[role="status"]')?.textContent??'';}
test('licenseReadOnly renders the specific subscription notice, not the generic Firebase one',async()=>{
 const notice=await render({granted:true,native:false,prompted:true,remote:false,configured:true,licenseBlocked:true});
 assert.match(notice,/اشتراكًا نشطًا للنادي/);assert.doesNotMatch(notice,/Firebase/);
});
test('successful remote registration keeps the enabled notice',async()=>{
 const notice=await render({granted:true,native:false,prompted:true,remote:true,configured:true});
 assert.match(notice,/تم تفعيل Push/);
});
test('missing server push config keeps its distinct notice',async()=>{
 const notice=await render({granted:true,native:false,prompted:true,remote:false,configured:false});
 assert.match(notice,/إعداد Push بالخادم غير مكتمل/);assert.doesNotMatch(notice,/اشتراكًا نشطًا/);
});
