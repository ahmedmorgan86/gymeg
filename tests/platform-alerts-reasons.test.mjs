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

test('push subscribe plain Error maps to unknown (allowlist rejects arbitrary names)',async()=>{
  setup({subscribe:async()=>{throw new Error('push service error');}});
  const r=await requestNotificationPermission('main');
  assert.equal(r.remote,false);assert.equal(r.reason,'push-subscribe-sub-unknown-sub0-keyna-swother-permg');
});

test('push subscribe InvalidStateError maps through allowlist with state fields',async()=>{
  const err=new Error('stale key');err.name='InvalidStateError';
  setup({subscribe:async()=>{throw err;}});
  const r=await requestNotificationPermission('main');
  assert.equal(r.remote,false);assert.equal(r.reason,'push-subscribe-sub-invalidstate-sub0-keyna-swother-permg');
});

test('push subscribe AbortError maps through allowlist',async()=>{
  const err=new Error('aborted');err.name='AbortError';
  setup({subscribe:async()=>{throw err;}});
  const r=await requestNotificationPermission('main');
  assert.equal(r.remote,false);assert.equal(r.reason,'push-subscribe-sub-abort-sub0-keyna-swother-permg');
});

test('arbitrary exception name never leaks (allowlist, not sanitization)',async()=>{
  const err=new Error('secret');err.name='Weird Name https://endpoint.example/token';
  setup({subscribe:async()=>{throw err;}});
  const r=await requestNotificationPermission('main');
  assert.equal(r.remote,false);assert.equal(r.reason,'push-subscribe-sub-unknown-sub0-keyna-swother-permg');
});

test('push subscribe non-object throw falls back to unknown',async()=>{
  setup({subscribe:async()=>{throw 'boom';}});
  const r=await requestNotificationPermission('main');
  assert.equal(r.remote,false);assert.equal(r.reason,'push-subscribe-sub-unknown-sub0-keyna-swother-permg');
});

test('getSubscription failure maps to get stage',async()=>{
  const err=new Error('x');err.name='AbortError';
  setup({swRegister:async()=>({active:{},pushManager:{getSubscription:async()=>{throw err;},subscribe:async()=>({toJSON:()=>subscriptionJson})}})});
  const r=await requestNotificationPermission('main');
  assert.equal(r.remote,false);assert.equal(r.reason,'push-subscribe-get-abort-sub0-keyna-swact-permg');
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
