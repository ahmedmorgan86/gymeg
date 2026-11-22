import {test} from 'node:test';
import assert from 'node:assert/strict';

// Reason-mapping coverage for the web (non-Android) path of
// requestNotificationPermission: each failure stage must surface its own safe
// reason token, and no success shape may carry one.
const {requestNotificationPermission}=await import('../app/lib/platform-alerts.ts');

const okJson=body=>({ok:true,status:200,json:async()=>body});
const subscriptionJson={endpoint:'https://push.example/x',keys:{p256dh:'k',auth:'a'}};

function setup({swRegister,configFetch,subscribe,postFetch}){
  globalThis.window={Notification:{permission:'granted'},PushManager:function(){}};
  globalThis.Notification=globalThis.window.Notification;
  Object.defineProperty(globalThis,'location',{value:{pathname:'/clubs'},configurable:true,writable:true});
  Object.defineProperty(globalThis,'navigator',{value:{serviceWorker:{register:swRegister??(async()=>({pushManager:{getSubscription:async()=>null,subscribe:subscribe??(async()=>({toJSON:()=>subscriptionJson}))}}))}},configurable:true,writable:true});
  globalThis.fetch=async(url,options)=>{
    if(options?.method==='POST'){
      if(postFetch)return postFetch(url,options);
      return okJson({ok:true,subscribed:true});
    }
    if(configFetch)return configFetch(url);
    return okJson({configured:true,publicKey:'BP__'+'_'.repeat(83)});
  };
}

test('service worker registration failure maps to sw-register',async()=>{
  setup({swRegister:async()=>{throw new Error('denied');}});
  const r=await requestNotificationPermission('main');
  assert.equal(r.remote,false);assert.equal(r.reason,'sw-register');assert.equal(r.configured,true);
});

test('config fetch network failure maps to config-fetch',async()=>{
  setup({configFetch:async()=>{throw new Error('offline');}});
  const r=await requestNotificationPermission('main');
  assert.equal(r.remote,false);assert.equal(r.reason,'config-fetch');
});

test('config not ok keeps configured:false without a reason',async()=>{
  setup({configFetch:async()=>({ok:false,status:500,json:async()=>({})})});
  const r=await requestNotificationPermission('main');
  assert.equal(r.remote,false);assert.equal(r.configured,false);assert.equal(r.reason,undefined);
});

test('push subscribe failure maps to push-subscribe',async()=>{
  setup({subscribe:async()=>{throw new Error('push service error');}});
  const r=await requestNotificationPermission('main');
  assert.equal(r.remote,false);assert.equal(r.reason,'push-subscribe');
});

test('POST network/timeout failure maps to post-network',async()=>{
  setup({postFetch:async()=>{throw new Error('timeout');}});
  const r=await requestNotificationPermission('main');
  assert.equal(r.remote,false);assert.equal(r.reason,'post-network');
});

test('POST http error maps to http-status',async()=>{
  setup({postFetch:async()=>({ok:false,status:401,json:async()=>({error:'auth'})})});
  const r=await requestNotificationPermission('main');
  assert.equal(r.remote,false);assert.equal(r.reason,'http-401');
});

test('POST 403 licenseReadOnly keeps licenseBlocked with http reason',async()=>{
  setup({postFetch:async()=>({ok:false,status:403,json:async()=>({error:'licenseReadOnly'})})});
  const r=await requestNotificationPermission('main');
  assert.equal(r.remote,false);assert.equal(r.reason,'http-403');assert.equal(r.licenseBlocked,true);
});

test('POST 503 keeps configured:false without a reason',async()=>{
  setup({postFetch:async()=>({ok:false,status:503,json:async()=>({error:'pushNotConfigured'})})});
  const r=await requestNotificationPermission('main');
  assert.equal(r.remote,false);assert.equal(r.configured,false);assert.equal(r.reason,undefined);
});

test('success carries no reason',async()=>{
  setup({});
  const r=await requestNotificationPermission('main');
  assert.equal(r.remote,true);assert.equal(r.reason,undefined);
});
