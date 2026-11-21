import {z} from 'zod';
import {codeMemberIdentity} from '../../lib/member-code-session';
import {context,readSpace,reply,sameOrigin} from '../../lib/server-workspace';
import {withScope} from '../../lib/database';
import {CommercialError,licenseState} from '../../lib/licensing';
import {normalizeLicense} from '../../lib/commercial';
import {webPushConfigured,webPushPublicKey} from '../../lib/web-push';
import {endpointDigest,encryptPushSubscription,isAllowedWebPushEndpoint,type WebPushSubscription} from '../../lib/push-crypto';
import {useFirestorePersistence} from '../../lib/firestore-db';
import {firebaseMemberLicense} from '../../lib/firebase-member-auth';
import {setWebPushSubscription} from '../../lib/firestore-web-push';

export const dynamic='force-dynamic';
export const runtime='nodejs';
const subscriptionSchema=z.object({endpoint:z.string().url().max(4096),expirationTime:z.number().nullable().optional(),keys:z.object({p256dh:z.string().regex(/^[A-Za-z0-9_-]{40,100}$/),auth:z.string().regex(/^[A-Za-z0-9_-]{16,64}$/)}).strict()}).strict();
const bodySchema=z.object({action:z.enum(['subscribe','unsubscribe']),branch:z.string().min(1).max(250).optional(),subscription:subscriptionSchema}).strict();

export async function GET(){return reply({configured:webPushConfigured(),publicKey:webPushPublicKey()||null});}

export async function POST(request:Request){
 if(!sameOrigin(request))return reply({error:'origin'},403);
 if(request.headers.get('content-type')?.split(';')[0]!=='application/json')return reply({error:'invalid'},415);
 try{
  const raw=await request.text();if(raw.length>12000)return reply({error:'limit'},413);
  const body=bodySchema.parse(JSON.parse(raw)),subscription=body.subscription as WebPushSubscription;
  if(!isAllowedWebPushEndpoint(subscription.endpoint))return reply({error:'invalid'},400);
  if(!webPushConfigured())return reply({error:'pushNotConfigured'},503);
  const identity=await codeMemberIdentity(request);
  let owner:string,recipientType:'staff'|'member',recipientId:string,branch:string;
  if(identity){
   if(identity.pin_must_change)return reply({error:'pinChangeRequired'},403);
   owner=identity.owner_id;recipientType='member';recipientId=identity.member_id;branch=identity.branch;
   const {state}=await readSpace(owner);if(!state.members.some(m=>m.id===recipientId&&m.branch===branch&&!m.demo&&!m.archived))return reply({error:'notLinked'},404);
   // Subscription is a license-gated write; unsubscription is the recipient's
   // own opt-out and must stay available even when the club is read-only.
   const license=useFirestorePersistence()?await firebaseMemberLicense(owner):await withScope(owner,async c=>(await c.query('SELECT l.* FROM gymos.tenant_licenses l JOIN gymos.tenants t ON t.id=l.tenant_id WHERE t.storage_key=$1',[owner])).rows[0]);
   if(body.action==='subscribe'&&license&&!licenseState(normalizeLicense(license)).writable)return reply({error:'licenseReadOnly'},403);
  }else{
   const ctx=await context();if(!ctx)return reply({error:'auth'},401);if(ctx.support||!['owner','manager'].includes(ctx.role))return reply({error:'forbidden'},403);
   if(body.action==='subscribe'&&ctx.license&&!licenseState(ctx.license).writable)return reply({error:'licenseReadOnly'},403);
   owner=ctx.owner;recipientType='staff';recipientId=ctx.user.userId;branch=body.branch??'';
   if(!branch||(ctx.branches&&!ctx.branches.includes(branch)))return reply({error:'forbidden'},403);
   const {state}=await readSpace(owner);if(!state.branches.some(b=>b.id===branch))return reply({error:'notFound'},404);
  }
  if(useFirestorePersistence()){
   await setWebPushSubscription(owner,branch,recipientType,recipientId,subscription,body.action==='subscribe');
   return reply({ok:true,subscribed:body.action==='subscribe'});
  }
  const endpointHash=endpointDigest(subscription.endpoint),ciphertext=encryptPushSubscription(subscription);
  await withScope(owner,async client=>{
   if(body.action==='subscribe')await client.query(
    `INSERT INTO gymos.push_subscriptions(owner_id,branch,recipient_type,recipient_id,endpoint_hash,subscription_ciphertext)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(owner_id,branch,recipient_type,recipient_id,endpoint_hash)
     DO UPDATE SET subscription_ciphertext=excluded.subscription_ciphertext,updated_at=now()`,
    [owner,branch,recipientType,recipientId,endpointHash,ciphertext]);
   else await client.query('DELETE FROM gymos.push_subscriptions WHERE owner_id=$1 AND branch=$2 AND recipient_type=$3 AND recipient_id=$4 AND endpoint_hash=$5',[owner,branch,recipientType,recipientId,endpointHash]);
  });
  return reply({ok:true,subscribed:body.action==='subscribe'});
 }catch(error){if(error instanceof CommercialError)return reply({error:error.code},error.status);if(error instanceof z.ZodError||error instanceof SyntaxError)return reply({error:'invalid'},400);return reply({error:'unavailable'},503);}
}
