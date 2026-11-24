import {z} from 'zod';
import {getChatGPTUser} from '../../chatgpt-auth';
import {platformAuthority} from '../../lib/platform-authority';
import {codeMemberIdentity} from '../../lib/member-code-session';
import {context,readSpaceCore,reply,sameOrigin} from '../../lib/server-workspace';
import {withScope} from '../../lib/database';
import {CommercialError,licenseState} from '../../lib/licensing';
import {normalizeLicense} from '../../lib/commercial';
import {encryptFcmToken,fcmTokenDigest,pushEncryptionConfigured} from '../../lib/push-crypto';
import {firebaseMessagingConfigured} from '../../lib/firebase-messaging';
import {isFirestorePersistence} from '../../lib/firestore-db';
import {firebaseMemberLicense} from '../../lib/firebase-member-auth';
import {setFcmSubscription} from '../../lib/firestore-fcm';

export const dynamic='force-dynamic';
export const runtime='nodejs';
const tokenSchema=z.string().min(80).max(4096).regex(/^[A-Za-z0-9:_-]+$/);
const bodySchema=z.object({action:z.enum(['register','unregister']),branch:z.string().min(1).max(250).optional(),audience:z.literal('support').optional(),token:tokenSchema}).strict();

export async function GET(){return reply({configured:pushEncryptionConfigured(),sendingConfigured:firebaseMessagingConfigured()});}
export async function POST(request:Request){
 if(!sameOrigin(request))return reply({error:'origin'},403);
 if(request.headers.get('content-type')?.split(';')[0]!=='application/json')return reply({error:'invalid'},415);
 try{
  const raw=await request.text();if(raw.length>6000)return reply({error:'limit'},413);
  const body=bodySchema.parse(JSON.parse(raw));if(body.action==='register'&&!pushEncryptionConfigured())return reply({error:'pushNotConfigured'},503);
  // Explicit platform-device enrollment is independent of any selected club or
  // temporary support cookie. Authenticate and check live platform authority,
  // then scope the token to this user only. Never take a user id from the body.
  if(body.audience==='support'){
   const user=await getChatGPTUser();if(!user)return reply({error:'auth'},401);
   if(isFirestorePersistence()||(body.action==='register'&&!(await platformAuthority(user))))return reply({error:'forbidden'},403);
   const tokenHash=fcmTokenDigest(body.token);
   await withScope(user.userId,async client=>{if(body.action==='register')await client.query(`INSERT INTO gymos.support_fcm_subscriptions(user_id,token_hash,token_ciphertext) VALUES($1,$2,$3) ON CONFLICT(user_id,token_hash) DO UPDATE SET token_ciphertext=excluded.token_ciphertext,updated_at=now()`,[user.userId,tokenHash,encryptFcmToken(body.token)]);else await client.query('DELETE FROM gymos.support_fcm_subscriptions WHERE user_id=$1 AND token_hash=$2',[user.userId,tokenHash]);});
   return reply({ok:true,registered:body.action==='register'});
  }
  const identity=await codeMemberIdentity(request);
  let owner:string,recipientType:'staff'|'member',recipientId:string,branch:string;
  if(identity){
   if(identity.pin_must_change)return reply({error:'pinChangeRequired'},403);
   owner=identity.owner_id;recipientType='member';recipientId=identity.member_id;branch=identity.branch;
   const {state}=await readSpaceCore(owner);if(!state.members.some(m=>m.id===recipientId&&m.branch===branch&&!m.demo&&!m.archived))return reply({error:'notLinked'},404);
   // Registration is a license-gated write; unregistration is the recipient's
   // own opt-out and must stay available even when the club is read-only.
   const license=isFirestorePersistence()?await firebaseMemberLicense(owner):await withScope(owner,async c=>(await c.query('SELECT l.* FROM gymos.tenant_licenses l JOIN gymos.tenants t ON t.id=l.tenant_id WHERE t.storage_key=$1',[owner])).rows[0]);
   if(body.action==='register'&&license&&!licenseState(normalizeLicense(license)).writable)return reply({error:'licenseReadOnly'},403);
  }else{
   // Opt-out stays available even when the club workspace is trial-locked.
   const ctx=await context(body.action!=='register');if(!ctx)return reply({error:'auth'},401);
   if(ctx.support){
    if(isFirestorePersistence())return reply({error:'supportUnavailable'},503);
    const tokenHash=fcmTokenDigest(body.token),userId=ctx.user.userId;
    await withScope(userId,async client=>{if(body.action==='register')await client.query(`INSERT INTO gymos.support_fcm_subscriptions(user_id,token_hash,token_ciphertext) VALUES($1,$2,$3) ON CONFLICT(user_id,token_hash) DO UPDATE SET token_ciphertext=excluded.token_ciphertext,updated_at=now()`,[userId,tokenHash,encryptFcmToken(body.token)]);else await client.query('DELETE FROM gymos.support_fcm_subscriptions WHERE user_id=$1 AND token_hash=$2',[userId,tokenHash]);});
    return reply({ok:true,registered:body.action==='register'});
   }
   if(!['owner','manager'].includes(ctx.role))return reply({error:'forbidden'},403);
   if(body.action==='register'&&ctx.license&&!licenseState(ctx.license).writable)return reply({error:'licenseReadOnly'},403);
   owner=ctx.owner;recipientType='staff';recipientId=ctx.user.userId;branch=body.branch??'';
   if(!branch||(ctx.branches&&!ctx.branches.includes(branch)))return reply({error:'forbidden'},403);
   const {state}=await readSpaceCore(owner);if(!state.branches.some(b=>b.id===branch))return reply({error:'notFound'},404);
  }
  const tokenHash=fcmTokenDigest(body.token);
  if(isFirestorePersistence()){await setFcmSubscription(owner,branch,recipientType,recipientId,body.token,body.action==='register');return reply({ok:true,registered:body.action==='register'});}
  await withScope(owner,async client=>{
   if(body.action==='register')await client.query(
    `INSERT INTO gymos.fcm_subscriptions(owner_id,branch,recipient_type,recipient_id,token_hash,token_ciphertext)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(owner_id,branch,recipient_type,recipient_id,token_hash)
     DO UPDATE SET token_ciphertext=excluded.token_ciphertext,updated_at=now()`,
    [owner,branch,recipientType,recipientId,tokenHash,encryptFcmToken(body.token)]);
   else await client.query('DELETE FROM gymos.fcm_subscriptions WHERE owner_id=$1 AND branch=$2 AND recipient_type=$3 AND recipient_id=$4 AND token_hash=$5',[owner,branch,recipientType,recipientId,tokenHash]);
  });
  return reply({ok:true,registered:body.action==='register'});
 }catch(error){if(error instanceof CommercialError)return reply({error:error.code},error.status);if(error instanceof z.ZodError||error instanceof SyntaxError)return reply({error:'invalid'},400);return reply({error:'unavailable'},503);}
}
