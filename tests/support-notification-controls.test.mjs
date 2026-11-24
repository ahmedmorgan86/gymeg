import './member-console-ui-loader.mjs';
import {test,after} from 'node:test';import assert from 'node:assert/strict';import {JSDOM} from 'jsdom';
const dom=new JSDOM('<div id="root"></div>',{url:'https://gym.test/platform',pretendToBeVisual:true});
for(const [key,value]of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,localStorage:dom.window.localStorage}))Object.defineProperty(globalThis,key,{value,configurable:true});
Object.defineProperty(navigator,'userAgent',{value:'GymEGSupportAndroid',configurable:true});globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const React=await import('react'),{createRoot}=await import('react-dom/client'),{default:Controls}=await import('../app/support-notification-controls.tsx');const root=createRoot(document.getElementById('root'));let calls=[],granted=false;
globalThis.fetch=async(url,init)=>{calls.push({url,init});if(url==='/__native_notifications_permission__')return Response.json({granted,requested:!granted});if(url==='/api/fcm-subscriptions')return Response.json(init?.method==='POST'?{ok:true}:{configured:true});if(url==='/__native_fcm_token__')return Response.json({token:'x'.repeat(150)});throw Error('unexpected '+url);};
const click=async label=>{await React.act(async()=>{[...document.querySelectorAll('button')].find(b=>b.textContent===label).click();await new Promise(r=>setTimeout(r,20));});};
test('support enrollment requires tap, waits for permission, registers without branch, and offers optout without sending push',async()=>{
 await React.act(async()=>root.render(React.createElement(Controls,{ar:false})));assert.equal(calls.length,0);
 await click('Enable support alerts');assert.match(document.body.textContent,/Allow Android notifications/);assert.equal(calls.length,1);
 granted=true;calls=[];await click('Enable support alerts');assert.match(document.body.textContent,/This device is registered/);assert.match(document.body.textContent,/Automatic support alerts are currently unavailable/);
 const writes=calls.filter(x=>x.init?.method==='POST');assert.equal(writes.length,1);assert.equal(writes[0].url,'/api/fcm-subscriptions');assert.deepEqual(JSON.parse(writes[0].init.body),{action:'register',audience:'support',token:'x'.repeat(150)});
 calls=[];await click('Disable support alerts');assert.match(document.body.textContent,/disabled for this device/);assert.deepEqual(JSON.parse(calls.find(x=>x.init?.method==='POST').init.body),{action:'unregister',audience:'support',token:'x'.repeat(150)});
});
after(async()=>{await React.act(async()=>root.unmount());dom.window.close();});
