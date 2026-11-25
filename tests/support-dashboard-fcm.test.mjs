import './acceptance-route-loader.mjs';
import {registerHooks} from 'node:module';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
import {test,after} from 'node:test';import assert from 'node:assert/strict';
const db=globalThis.__supportDb=await bootstrapDb({through:'20261121191200_member_portal_claim_policy.sql'});
registerHooks({resolve(specifier,ctx,next){if(specifier==='next/headers')return{url:'data:text/javascript,export const cookies=async()=>({get:(key)=>key==="gymos-space"&&globalThis.__acceptanceClub?{value:globalThis.__acceptanceClub}:undefined});',shortCircuit:true};return next(specifier,ctx);},load(url,ctx,next){
 if(url.endsWith('/app/lib/member-code-session.ts'))return{format:'module',shortCircuit:true,source:'export const codeMemberIdentity=async()=>null;'};
 if(url.endsWith('/app/lib/database.ts'))return{format:'module',shortCircuit:true,source:`export const db={};export const getPool=()=>({connect:async()=>({query:async(sql,p)=>{const r=await globalThis.__supportDb.query(sql,p);if(sql==='BEGIN')await globalThis.__supportDb.query('SET LOCAL ROLE gymos_app');return {...r,rowCount:r.rowCount??r.rows.length};},release(){}})});export const withScope=async(owner,fn)=>globalThis.__supportDb.transaction(async c=>{await c.query('SET LOCAL ROLE gymos_app');await c.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);return fn(c);});`};
 return next(url,ctx);
}});
process.env.GYMOS_COMMERCIAL='1';process.env.GYMOS_DATA_BACKEND='postgres';process.env.GYMEG_PUSH_SUBSCRIPTION_KEY=Buffer.alloc(32,5).toString('base64');
const {POST}=await import('../app/api/fcm-subscriptions/route.ts');const {context}=await import('../app/lib/server-workspace.ts');const {decryptFcmToken,fcmTokenDigest}=await import('../app/lib/push-crypto.ts');
const user='00000000-0000-0000-0000-000000000001',other='00000000-0000-0000-0000-000000000002',token='support-device-'+ 'x'.repeat(100);
const req=(action,extra={})=>new Request('https://gym.test/api/fcm-subscriptions',{method:'POST',headers:{origin:'https://gym.test','content-type':'application/json'},body:JSON.stringify({action,audience:'support',token,...extra})});
const rows=()=>db.query('SELECT user_id,token_hash,token_ciphertext FROM gymos.support_fcm_subscriptions ORDER BY user_id');
test('real platform authority enrolls dashboard without club/support cookie; real context still requires club; own-token optout survives revocation',async()=>{
 await db.query('INSERT INTO gymos.platform_admins(user_id) VALUES($1)',[user]);globalThis.__acceptanceUser={userId:user,email:'admin@example.invalid'};globalThis.__acceptanceClub=undefined;
 await assert.rejects(()=>context(),e=>e.code==='chooseClub'); // no fabricated support context
 assert.equal((await POST(req('register'))).status,200);
 let r=await rows();assert.equal(r.rows.length,1);assert.equal(r.rows[0].user_id,user);assert.equal(r.rows[0].token_hash,fcmTokenDigest(token));assert.equal(decryptFcmToken(r.rows[0].token_ciphertext),token);assert.notEqual(r.rows[0].token_ciphertext,token);
 await db.query("INSERT INTO gymos.tenants(id,storage_key,name,created_by) VALUES('club-one','tenant:club-one','Fixture club',$1)",[user]);
 await db.query("INSERT INTO gymos.tenant_memberships(tenant_id,user_id,role) VALUES('club-one',$1,'owner')",[user]);
 await db.query("INSERT INTO gymos.tenant_licenses(tenant_id,plan_id,mode,status,limits) VALUES('club-one','legacy','perpetual','active','{}')");
 process.env.GYMOS_PLATFORM_OWNER_ACCOUNT_ID=user;globalThis.__acceptanceClub='club-one';const selected=await context();assert.equal(selected.platformOwnerAccess,true);assert.equal(selected.support,undefined);
 assert.equal((await POST(req('register'))).status,200);assert.equal((await rows()).rows[0].user_id,user);
 // A selected but nonexistent club cannot redirect platform-device registration.
 globalThis.__acceptanceClub='foreign-nonexistent-club';assert.equal((await POST(req('register'))).status,200);assert.equal((await rows()).rows.length,1);
 globalThis.__acceptanceUser={userId:other,email:'nonadmin@example.invalid'};
 assert.equal((await POST(req('register'))).status,403);assert.equal((await POST(req('unregister'))).status,200);assert.equal((await rows()).rows.length,1);
 globalThis.__acceptanceUser=null;assert.equal((await POST(req('register'))).status,401);assert.equal((await POST(req('unregister'))).status,401);
 globalThis.__acceptanceUser={userId:user,email:'admin@example.invalid'};await db.query('DELETE FROM gymos.platform_admins WHERE user_id=$1',[user]);
 assert.equal((await POST(req('register'))).status,403);assert.equal((await POST(req('unregister'))).status,200);assert.equal((await rows()).rows.length,0);
 assert.equal((await db.query('SELECT 1 FROM gymos.fcm_subscriptions')).rows.length,0);
});
after(async()=>{await db.close();});

test('session push sends only to the actor and removes only their expired token',async()=>{
 const {generateKeyPairSync}=await import('node:crypto');
 const {sendSupportFcm}=await import('../app/lib/firebase-messaging.ts');
 const {encryptFcmToken}=await import('../app/lib/push-crypto.ts');
 const private_key=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'pem',type:'pkcs8'});
 const previous=process.env.GYMEG_MOBILE_NOTIFICATIONS_SERVICE_ACCOUNT;
 const originalFetch=globalThis.fetch;
 const deviceTokens=[token,token+'expired',token+'other'];
 for(const [index,value] of deviceTokens.entries())await db.query(
  'INSERT INTO gymos.support_fcm_subscriptions(user_id,token_hash,token_ciphertext) VALUES($1,$2,$3)',
  [index===2?other:user,fcmTokenDigest(value),encryptFcmToken(value)]);
 const sent=[];
 process.env.GYMEG_MOBILE_NOTIFICATIONS_SERVICE_ACCOUNT=JSON.stringify({project_id:'gymeg-mobile-notifications',client_email:'gymeg-fcm-sender@gymeg-mobile-notifications.iam.gserviceaccount.com',private_key});
 globalThis.fetch=async (url,options)=>{
  if(String(url)==='https://oauth2.googleapis.com/token')return Response.json({access_token:'mock'});
  assert.match(String(url),/^https:\/\/fcm.googleapis.com\//);
  const {message}=JSON.parse(options.body);sent.push(message);
  return message.token===deviceTokens[1]?Response.json({error:{status:'UNREGISTERED'}},{status:404}):Response.json({});
 };
 try{
  await sendSupportFcm(user,'started');
  assert.deepEqual(sent.map(message=>message.token).sort(),deviceTokens.slice(0,2).sort());
  for(const message of sent){assert.equal(message.data.url,'/platform');assert.match(message.data.tag,/^started-/);}
  assert.deepEqual((await rows()).rows.map(row=>row.token_hash).sort(),[fcmTokenDigest(token),fcmTokenDigest(deviceTokens[2])].sort());
 }finally{
  globalThis.fetch=originalFetch;
  if(previous===undefined)delete process.env.GYMEG_MOBILE_NOTIFICATIONS_SERVICE_ACCOUNT;
  else process.env.GYMEG_MOBILE_NOTIFICATIONS_SERVICE_ACCOUNT=previous;
 }
});

test('ending the same support session records a single event',async()=>{
 const {startSupport,endSupport}=await import('../app/lib/platform-support.ts');
 const {supportToken}=await db.transaction(client=>startSupport(client,true,user,'club-one','Synthetic session for the ending check'));
 assert.equal((await db.transaction(client=>endSupport(client,true,other,supportToken))).ended,false);
 assert.equal((await db.transaction(client=>endSupport(client,true,user,supportToken))).ended,true);
 assert.equal((await db.transaction(client=>endSupport(client,true,user,supportToken))).ended,false);
});
