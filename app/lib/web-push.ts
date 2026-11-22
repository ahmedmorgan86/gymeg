import 'server-only';
import webPush from 'web-push';
import {withScope} from './database';
import {decryptPushSubscription,pushEncryptionConfigured} from './push-crypto';
import {sendCommunityFcm,firebaseMessagingConfigured} from './firebase-messaging';
import {isFirestorePersistence} from './firestore-db.ts';
import {eligibleWebPushSubscriptions} from './firestore-web-push';
export type PushRecipient='staff'|'member';
const subject=()=>process.env.GYMEG_VAPID_SUBJECT?.trim()||'';
const publicKey=()=>process.env.GYMEG_VAPID_PUBLIC_KEY?.trim()||'';
const privateKey=()=>process.env.GYMEG_VAPID_PRIVATE_KEY?.trim()||'';
export function webPushConfigured(){
 const publicBytes=Buffer.from(publicKey(),'base64url'),privateBytes=Buffer.from(privateKey(),'base64url');
 return Boolean(pushEncryptionConfigured()&&(subject().startsWith('mailto:')||subject().startsWith('https://'))&&publicBytes.length===65&&privateBytes.length===32);
}
export function webPushPublicKey(){return publicKey();}

/** Deliver generic, privacy-preserving chat alerts only within one active club branch. */
export async function sendCommunityPush(owner:string,branch:string,recipient:PushRecipient,recipientId:string|null,url:'/member'|'/clubs',tag:string){
 const webConfigured=webPushConfigured(),fcmConfigured=firebaseMessagingConfigured();
 if(!webConfigured&&!fcmConfigured)return {configured:false,sent:0,failed:0};
 const native=await sendCommunityFcm(owner,branch,recipient,recipientId,url,tag);
 if(!webConfigured)return native;
 if(isFirestorePersistence()){
  const rows=await eligibleWebPushSubscriptions(owner,branch,recipient,recipientId);
  webPush.setVapidDetails(subject(),publicKey(),privateKey());
  let sent=0,failed=0;
  await Promise.all(rows.map(async row=>{
   try{await webPush.sendNotification(decryptPushSubscription(row.subscription_ciphertext),JSON.stringify({title:'GymEG',body:'وصلتك رسالة جديدة من ناديك / You have a new club message.',url,tag:'club-message-'+tag.slice(0,24)}),{TTL:120,urgency:'high',timeout:8000});sent++;}
   catch(error){failed++;if([404,410].includes(Number((error as {statusCode?:unknown})?.statusCode)))await row.ref.delete();}
  }));
  return {configured:true,sent:sent+native.sent,failed:failed+native.failed};
 }
 const rows=await withScope(owner,async client=>(await client.query(
  `SELECT p.subscription_id,p.subscription_ciphertext
     FROM gymos.push_subscriptions p
    WHERE p.owner_id=$1 AND p.branch=$2 AND p.recipient_type=$3
      AND ($4::text IS NULL OR p.recipient_id=$4)
      AND (p.recipient_type='member' OR p.recipient_id=$1 OR EXISTS(
        SELECT 1 FROM gymos.tenant_memberships m JOIN gymos.tenants t ON t.id=m.tenant_id
         WHERE t.storage_key=p.owner_id AND m.user_id=p.recipient_id AND m.role IN ('owner','manager') AND NOT m.revoked
           AND (m.branches IS NULL OR m.branches ? p.branch)
      ) OR EXISTS(
        SELECT 1 FROM gymos.gym_access a WHERE a.owner_id=p.owner_id AND a.user_id=p.recipient_id AND a.role IN ('owner','manager') AND a.revoked=0
          AND (a.branches IS NULL OR a.branches::jsonb ? p.branch)
      ))
    ORDER BY p.created_at DESC LIMIT 250`,[owner,branch,recipient,recipientId])).rows);
 if(!rows.length)return {configured:true,sent:native.sent,failed:native.failed};
 webPush.setVapidDetails(subject(),publicKey(),privateKey());
 let sent=0,failed=0;
 await Promise.all(rows.map(async row=>{
  try{
   const subscription=decryptPushSubscription(String(row.subscription_ciphertext));
   await webPush.sendNotification(subscription,JSON.stringify({title:'GymEG',body:'وصلتك رسالة جديدة من ناديك / You have a new club message.',url,tag:'club-message-'+tag.slice(0,24)}),{TTL:120,urgency:'high',timeout:8000});sent++;
  }catch(error){failed++;const status=Number((error as {statusCode?:unknown})?.statusCode);if(status===404||status===410){try{await withScope(owner,client=>client.query('DELETE FROM gymos.push_subscriptions WHERE owner_id=$1 AND subscription_id=$2',[owner,row.subscription_id]).then(()=>undefined));}catch{}}
  }
 }));
 return {configured:true,sent:sent+native.sent,failed:failed+native.failed};
}
