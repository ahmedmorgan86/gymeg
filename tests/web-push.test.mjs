import test from 'node:test';
import assert from 'node:assert/strict';
import {decryptPushSubscription,encryptPushSubscription,endpointDigest,isAllowedWebPushEndpoint,pushEncryptionConfigured} from '../app/lib/push-crypto.ts';

const subscription={endpoint:'https://push.example.invalid/subscription/token',expirationTime:null,keys:{p256dh:'A'.repeat(65),auth:'B'.repeat(22)}};
test('push subscriptions are encrypted with authenticated encryption and round-trip',()=>{
 const old=process.env.GYMEG_PUSH_SUBSCRIPTION_KEY;process.env.GYMEG_PUSH_SUBSCRIPTION_KEY=Buffer.alloc(32,7).toString('base64');
 try{const cipher=encryptPushSubscription(subscription);assert.doesNotMatch(cipher,/push\.example\.invalid/);assert.deepEqual(decryptPushSubscription(cipher),subscription);const [iv,tag,payload]=cipher.split('.');const tamperedTag=(tag[0]==='A'?'B':'A')+tag.slice(1);assert.throws(()=>decryptPushSubscription(`${iv}.${tamperedTag}.${payload}`));}
 finally{if(old===undefined)delete process.env.GYMEG_PUSH_SUBSCRIPTION_KEY;else process.env.GYMEG_PUSH_SUBSCRIPTION_KEY=old;}
});
test('subscription endpoint identifiers are one-way hashes',()=>{const a=endpointDigest(subscription.endpoint),b=endpointDigest(subscription.endpoint);assert.equal(a,b);assert.match(a,/^[a-f0-9]{64}$/);assert.notEqual(a,subscription.endpoint);});
test('push endpoints are restricted to browser push providers and subscription encryption must be configured',()=>{
 assert.equal(isAllowedWebPushEndpoint('https://fcm.googleapis.com/fcm/send/token'),true);
 assert.equal(isAllowedWebPushEndpoint('https://sub.push.services.mozilla.com/token'),true);
 assert.equal(isAllowedWebPushEndpoint('https://127.0.0.1/private'),false);
 assert.equal(isAllowedWebPushEndpoint('https://attacker.example/token'),false);
 assert.equal(isAllowedWebPushEndpoint('http://fcm.googleapis.com/token'),false);
 const old=process.env.GYMEG_PUSH_SUBSCRIPTION_KEY;delete process.env.GYMEG_PUSH_SUBSCRIPTION_KEY;assert.equal(pushEncryptionConfigured(),false);
 process.env.GYMEG_PUSH_SUBSCRIPTION_KEY=Buffer.alloc(31).toString('base64');assert.equal(pushEncryptionConfigured(),false);
 process.env.GYMEG_PUSH_SUBSCRIPTION_KEY=Buffer.alloc(32).toString('base64');assert.equal(pushEncryptionConfigured(),true);
 if(old===undefined)delete process.env.GYMEG_PUSH_SUBSCRIPTION_KEY;else process.env.GYMEG_PUSH_SUBSCRIPTION_KEY=old;
});
