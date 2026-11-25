import 'server-only';
import {createPrivateKey,createSign} from 'node:crypto';
import {withScope} from './database';
import {decryptFcmToken} from './push-crypto';
import {isFirestorePersistence} from './firestore-db.ts';
import {eligibleFcmSubscriptions} from './firestore-fcm';

type ServiceAccount={project_id:string;client_email:string;private_key:string};
let cached:{accessToken:string;expiresAt:number}|null=null;
const b64url=(value:string|Buffer)=>Buffer.from(value).toString('base64url');
function serviceAccount():ServiceAccount|null{
 try{
  const value=JSON.parse(process.env.GYMEG_MOBILE_NOTIFICATIONS_SERVICE_ACCOUNT??process.env.GYMEG_FIREBASE_SERVICE_ACCOUNT??'') as Partial<ServiceAccount>;
  const expectedProject=process.env.GYMEG_MOBILE_NOTIFICATIONS_PROJECT_ID?.trim()||'gymeg-mobile-notifications';
  if(value.project_id!==expectedProject||value.client_email!=='gymeg-fcm-sender@gymeg-mobile-notifications.iam.gserviceaccount.com'||typeof value.private_key!=='string')return null;
  if(createPrivateKey(value.private_key).asymmetricKeyType!=='rsa')return null;
  return value as ServiceAccount;
 }catch{return null;}
}
export function firebaseMessagingConfigured(){return serviceAccount()!==null;}
async function bearerToken(account:ServiceAccount){
 if(cached&&cached.expiresAt>Date.now()+60_000)return cached.accessToken;
 const now=Math.floor(Date.now()/1000),header=b64url(JSON.stringify({alg:'RS256',typ:'JWT'})),claims=b64url(JSON.stringify({iss:account.client_email,scope:'https://www.googleapis.com/auth/firebase.messaging',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600})),unsigned=header+'.'+claims,signer=createSign('RSA-SHA256');signer.update(unsigned);const assertion=unsigned+'.'+signer.sign(account.private_key).toString('base64url');
 const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion}),signal:AbortSignal.timeout(8000)});
 if(!response.ok)throw Error('FCM authentication failed');const body=await response.json() as {access_token?:unknown;expires_in?:unknown};if(typeof body.access_token!=='string')throw Error('FCM authentication failed');cached={accessToken:body.access_token,expiresAt:Date.now()+(typeof body.expires_in==='number'?body.expires_in:3600)*1000};return cached.accessToken;
}
async function sendOne(account:ServiceAccount,token:string,url:'/member'|'/clubs'|'/platform',tag:string){
 const access=await bearerToken(account),support=url==='/platform',response=await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`,{method:'POST',headers:{authorization:`Bearer ${access}`,'content-type':'application/json'},body:JSON.stringify({message:{token,notification:{title:support?'GymEG Support':'GymEG',body:support?'لديك تنبيه دعم جديد / New support alert':'وصلتك رسالة جديدة من ناديك / You have a new club message.'},data:{url,tag:tag.slice(0,48)},android:{priority:'HIGH',notification:{channel_id:support?'gymeg_support':'gymeg_messages',tag:(support?'support-':'club-message-')+tag.slice(0,24),click_action:support?'GYMEG_SUPPORT_NOTIFICATION':'GYMEG_OPEN_NOTIFICATION'}}}}),signal:AbortSignal.timeout(8000)});
 if(response.ok)return{ok:true,expired:false};
 const status=response.status;let code='';try{const payload=await response.json() as {error?:{details?:Array<{errorCode?:string}>;status?:string}};code=payload.error?.details?.find(x=>x.errorCode)?.errorCode??payload.error?.status??'';}catch{}
 if(status===404||code==='UNREGISTERED')return{ok:false,expired:true};
 return{ok:false,expired:false};
}

/** Send privacy-safe chat alerts to registered native Android devices in one tenant branch. */
export async function sendCommunityFcm(owner:string,branch:string,recipient:'staff'|'member',recipientId:string|null,url:'/member'|'/clubs',tag:string){
 const account=serviceAccount();if(!account)return{configured:false,sent:0,failed:0};
 if(isFirestorePersistence()){
  const rows=await eligibleFcmSubscriptions(owner,branch,recipient,recipientId);let sent=0,failed=0;
  await Promise.all(rows.map(async row=>{try{const result=await sendOne(account,decryptFcmToken(row.token_ciphertext),url,tag);if(result.ok)sent++;else{failed++;if(result.expired)await row.ref.delete();}}catch{failed++;}}));
  return{configured:true,sent,failed};
 }
 const rows=await withScope(owner,async client=>(await client.query(
  `SELECT f.subscription_id,f.token_ciphertext
     FROM gymos.fcm_subscriptions f
    WHERE f.owner_id=$1 AND f.branch=$2 AND f.recipient_type=$3
      AND ($4::text IS NULL OR f.recipient_id=$4)
      AND (f.recipient_type='member' OR f.recipient_id=$1 OR EXISTS(
        SELECT 1 FROM gymos.tenant_memberships m JOIN gymos.tenants t ON t.id=m.tenant_id
         WHERE t.storage_key=f.owner_id AND m.user_id=f.recipient_id AND m.role IN ('owner','manager') AND NOT m.revoked
           AND (m.branches IS NULL OR m.branches ? f.branch)
      ) OR EXISTS(
        SELECT 1 FROM gymos.gym_access a WHERE a.owner_id=f.owner_id AND a.user_id=f.recipient_id AND a.role IN ('owner','manager') AND a.revoked=0
          AND (a.branches IS NULL OR a.branches::jsonb ? f.branch)
      ))
    ORDER BY f.created_at DESC LIMIT 250`,[owner,branch,recipient,recipientId])).rows);
 let sent=0,failed=0;
 await Promise.all(rows.map(async row=>{
  try{const token=decryptFcmToken(String(row.token_ciphertext)),result=await sendOne(account,token,url,tag);if(result.ok)sent++;else{failed++;if(result.expired)await withScope(owner,client=>client.query('DELETE FROM gymos.fcm_subscriptions WHERE owner_id=$1 AND subscription_id=$2',[owner,row.subscription_id]).then(()=>undefined));}}
  catch{failed++;}
 }));
 return{configured:true,sent,failed};
}

/** Alerts only registered devices owned by the authorized support session actor. */
export async function sendSupportFcm(userId:string,event:'started'|'ended'){
 if(isFirestorePersistence())return;
 const account=serviceAccount();
 if(!account)return;
 const rows=await withScope(userId,async client=>(await client.query(
  'SELECT token_hash,token_ciphertext FROM gymos.support_fcm_subscriptions WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 12',[userId])).rows);
 const tag=event+'-'+crypto.randomUUID();
 await Promise.allSettled(rows.map(async row=>{
  const result=await sendOne(account,decryptFcmToken(String(row.token_ciphertext)),'/platform',tag);
  if(result.expired)await withScope(userId,client=>client.query(
   'DELETE FROM gymos.support_fcm_subscriptions WHERE user_id=$1 AND token_hash=$2 AND token_ciphertext=$3',
   [userId,row.token_hash,row.token_ciphertext]));
 }));
}
