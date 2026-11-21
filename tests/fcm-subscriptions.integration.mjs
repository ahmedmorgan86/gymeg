import test from 'node:test';
import assert from 'node:assert/strict';
import {GET,POST} from '../app/api/fcm-subscriptions/route.ts';
import {decryptFcmToken} from '../app/lib/push-crypto.ts';

const token='fcm-test-token-'+ 'x'.repeat(100);
const request=(body,{origin='https://gym.example'}={})=>new Request('https://gym.example/api/fcm-subscriptions',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});
function setup(){
 process.env.GYMEG_PUSH_SUBSCRIPTION_KEY=Buffer.alloc(32,5).toString('base64');delete process.env.GYMEG_FIREBASE_SERVICE_ACCOUNT;delete process.env.GYMEG_FIREBASE_PROJECT_ID;
 globalThis.__fcmQueries=[];globalThis.__fcmOwners=[];globalThis.__fcmIdentity=null;globalThis.__fcmContext=null;
 globalThis.__fcmSpace={state:{members:[{id:'member-1',branch:'north',demo:false,archived:false}],branches:[{id:'north'}]}};
}
test('device enrollment remains available when server-side FCM sending credential is not configured',async()=>{
 setup();const response=await GET();assert.deepEqual(await response.json(),{configured:true,sendingConfigured:false});
});
test('member FCM token is bound to verified tenant and branch and encrypted before storage',async()=>{
 setup();globalThis.__fcmIdentity={owner_id:'club-a',member_id:'member-1',branch:'north',pin_must_change:false};
 const response=await POST(request({action:'register',branch:'foreign',token}));assert.equal(response.status,200);
 const insert=globalThis.__fcmQueries.find(x=>x.text.includes('INSERT INTO gymos.fcm_subscriptions'));assert.ok(insert);
 assert.deepEqual(insert.params.slice(0,4),['club-a','north','member','member-1']);assert.notEqual(insert.params[5],token);assert.equal(decryptFcmToken(insert.params[5]),token);assert.equal(globalThis.__fcmOwners.every(owner=>owner==='club-a'),true);
});
test('manager FCM token registration requires owner role and assigned branch',async()=>{
 setup();globalThis.__fcmContext={owner:'club-a',user:{userId:'manager-1'},role:'manager',branches:['north'],support:false};
 assert.equal((await POST(request({action:'register',branch:'south',token}))).status,403);
 assert.equal((await POST(request({action:'register',branch:'north',token}))).status,200);
 globalThis.__fcmContext={owner:'club-a',user:{userId:'reception-1'},role:'reception',branches:['north'],support:false};assert.equal((await POST(request({action:'register',branch:'north',token}))).status,403);
});
test('support tokens use a separate authenticated user scope and are not mixed with club subscriptions',async()=>{
 setup();globalThis.__fcmContext={owner:'platform',user:{userId:'support-user'},role:'owner',branches:[],support:true};
 const response=await POST(request({action:'register',token}));assert.equal(response.status,200);
 const insert=globalThis.__fcmQueries.find(x=>x.text.includes('INSERT INTO gymos.support_fcm_subscriptions'));assert.ok(insert);assert.deepEqual(insert.params.slice(0,1),['support-user']);assert.deepEqual(globalThis.__fcmOwners,['support-user']);
});
test('read-only club license blocks registration but never the recipient own opt-out',async()=>{
 setup();globalThis.__fcmContext={owner:'club-a',user:{userId:'manager-1'},role:'manager',branches:['north'],support:false,license:{status:'suspended'}};
 globalThis.__fcmLicenseState={writable:false};
 const blocked=await POST(request({action:'register',branch:'north',token}));
 assert.equal(blocked.status,403);assert.deepEqual(await blocked.json(),{error:'licenseReadOnly'});
 assert.equal(globalThis.__fcmQueries.some(x=>x.text.includes('INSERT INTO gymos.fcm_subscriptions')),false);
 const optOut=await POST(request({action:'unregister',branch:'north',token}));
 assert.equal(optOut.status,200);
 assert.equal(globalThis.__fcmQueries.some(x=>x.text.includes('DELETE FROM gymos.fcm_subscriptions')),true);
});
test('member opt-out survives a read-only club license while registration stays gated',async()=>{
 setup();globalThis.__fcmIdentity={owner_id:'club-a',member_id:'member-1',branch:'north',pin_must_change:false};
 globalThis.__fcmLicenseState={writable:false};globalThis.__fcmLicenseRow={tenant_id:'t',status:'suspended'};
 const blocked=await POST(request({action:'register',branch:'north',token}));
 assert.equal(blocked.status,403);assert.deepEqual(await blocked.json(),{error:'licenseReadOnly'});
 const optOut=await POST(request({action:'unregister',branch:'north',token}));
 assert.equal(optOut.status,200);
 assert.equal(globalThis.__fcmQueries.some(x=>x.text.includes('DELETE FROM gymos.fcm_subscriptions')),true);
});
