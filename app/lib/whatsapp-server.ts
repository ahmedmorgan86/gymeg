import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {getPool,withScope} from './database';
import {readSpace} from './server-workspace';
import {readWhatsAppJobPage,type WhatsAppCursor} from './whatsapp-job-page';
import {useFirestorePersistence} from './firestore-db';
import type {GymState} from './domain';
import {dueMessages,whatsappRule,whatsappPhone,templateMessage} from './whatsapp';
import {normalizeLicense} from './commercial';
import {licenseState,type License} from './licensing';
const demandWhatsAppReads=()=>process.env.GYMOS_WHATSAPP_READS==='1'&&!useFirestorePersistence();
async function* ruleJobs(owner:string,rule:Parameters<typeof dueMessages>[1],now:string,deadline:number,legacyState?:GymState){
 if(demandWhatsAppReads()){
  try{let after:WhatsAppCursor|undefined,version:string|undefined;
   do{if(Date.now()>=deadline)return;const page=await readWhatsAppJobPage(withScope,{owner,rule,now,after,version});if(page.status!=='ok')break;
    for(const job of page.jobs)yield job;
    if(!page.next)return;after=page.next;version=page.version;
   }while(true);
  }catch{/* Exact full-state fallback below. Already queued ids are idempotent. */}
 }
 if(demandWhatsAppReads()&&Date.now()>=deadline)return;const state=legacyState??(await readSpace(owner)).state;for(const job of dueMessages(state,rule,now))yield job;
}
async function latestJob(owner:string,rule:Parameters<typeof dueMessages>[1],memberId:string,occurrence:string,now:string){
 if(demandWhatsAppReads())try{const page=await readWhatsAppJobPage(withScope,{owner,rule,now,memberId});if(page.status==='ok')return page.jobs.find(j=>j.member===memberId&&j.occurrence===occurrence)??null;}catch{/* Preserve exact legacy fallback. */}
 const {state}=await readSpace(owner);return dueMessages(state,rule,now).find(j=>j.member===memberId&&j.occurrence===occurrence)??null;
}
export async function runWhatsApp(owner:string,branch?:string,deadline=Date.now()+40000){const legacyState=demandWhatsAppReads()?undefined:(await readSpace(owner)).state;const allowed=await withScope(owner,async c=>{const l=(await c.query('SELECT l.* FROM gymos.tenant_licenses l JOIN gymos.tenants t ON t.id=l.tenant_id WHERE t.storage_key=$1',[owner])).rows[0] as License|undefined;return !l||licenseState(normalizeLicense(l)).writable;});if(!allowed)return{sent:0,blocked:true};const rules=await withScope(owner,async c=>(await c.query('SELECT payload FROM gymos.whatsapp_rules WHERE owner_id=$1 AND ($2::text IS NULL OR branch=$2)',[owner,branch??null])).rows);let sent=0;for(const row of rules){const parsed=whatsappRule.safeParse(row.payload);if(!parsed.success)continue;const rule=parsed.data;for await(const job of ruleJobs(owner,rule,new Date().toISOString(),deadline,legacyState)){const id=createHash('sha256').update(JSON.stringify([owner,rule.id,job.member,job.occurrence])).digest('hex');await withScope(owner,c=>c.query("INSERT INTO gymos.whatsapp_outbox(owner_id,id,branch,member_id,rule_id,occurrence,status,payload) VALUES($1,$2,$3,$4,$5,$6,'pending',$7) ON CONFLICT DO NOTHING",[owner,id,rule.branch,job.member,rule.id,job.occurrence,JSON.stringify({to:job.to,rule,parameters:job.parameters})]));}}
 for(let i=0;i<20&&Date.now()<deadline;i++){const job=await withScope(owner,async c=>{const selected=(await c.query("SELECT * FROM gymos.whatsapp_outbox WHERE owner_id=$1 AND status='pending' AND ($2::text IS NULL OR branch=$2) ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT 1",[owner,branch??null])).rows[0];if(!selected)return null;const connection=(await c.query('SELECT * FROM gymos.whatsapp_connections WHERE owner_id=$1 AND branch=$2',[owner,selected.branch])).rows[0];if(!connection)return null;await c.query("UPDATE gymos.whatsapp_outbox SET status='sending',updated_at=now() WHERE owner_id=$1 AND id=$2",[owner,selected.id]);return{...selected,connection};});if(!job)break;let status='unknown',provider:string|null=null,error:string|null=null;try{const phoneDigest=whatsappPhoneDigest(String(job.payload?.to??''));const optedOut=phoneDigest?await whatsappOptedOut(owner,phoneDigest):false;const currentRule=await withScope(owner,async c=>(await c.query('SELECT payload FROM gymos.whatsapp_rules WHERE owner_id=$1 AND id=$2',[owner,job.rule_id])).rows[0]);const parsedRule=currentRule?whatsappRule.safeParse(currentRule.payload):null;const due=parsedRule?.success&&parsedRule.data.branch===job.branch?await latestJob(owner,parsedRule.data,job.member_id,job.occurrence,new Date().toISOString()):null;if(optedOut||!due||due.to!==job.payload.to||!currentRule?.payload.enabled){status='cancelled';}else{const token=await withScope(owner,async c=>(await c.query('SELECT gymos.messaging_decrypt($1,$2) AS token',[job.branch,job.connection.token_cipher])).rows[0].token);const r=await fetch('https://graph.facebook.com/'+job.connection.api_version+'/'+job.connection.phone_id+'/messages',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(templateMessage(whatsappRule.parse(currentRule.payload),due!.to,due!.parameters)),signal:AbortSignal.timeout(15000)});const d=await r.json();if(r.ok&&typeof d.messages?.[0]?.id==='string'){status='sent';provider=d.messages[0].id;sent++;}else{status='failed';error='provider_'+String(d.error?.code??r.status).slice(0,30);}}}catch{error='delivery_unconfirmed_do_not_retry_automatically';}await withScope(owner,c=>c.query('UPDATE gymos.whatsapp_outbox SET status=$3,provider_id=$4,error=$5,updated_at=now() WHERE owner_id=$1 AND id=$2',[owner,job.id,status,provider,error]));}
 // A crashed sender may have delivered. Never retry these automatically.
 await withScope(owner,c=>c.query("UPDATE gymos.whatsapp_outbox SET status='unknown',error='delivery_unconfirmed',updated_at=now() WHERE owner_id=$1 AND status='sending' AND updated_at<now()-interval '10 minutes'",[owner]));return{sent};}

// B11: signed inbound webhook helpers. Secrets stay in server-only env vars
// and are never included in responses or logs.
type WebhookQuery=(sql:string,params:unknown[])=>Promise<{rows:Record<string,unknown>[]}>;
function constantTimeEqual(a:string,b:string){return timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());}
export function verifyWebhookToken(token:string|null){const expected=process.env.GYMEG_WHATSAPP_WEBHOOK_VERIFY_TOKEN;return !!token&&token.length<=512&&!!expected&&constantTimeEqual(token,expected);}
export function verifyWebhookSignature(raw:Uint8Array|string,header:string|null,secret:string){if(!header||!secret)return false;const match=/^sha256=([a-f0-9]{64})$/i.exec(header);if(!match)return false;return constantTimeEqual(match[1].toLowerCase(),createHmac('sha256',secret).update(raw).digest('hex'));}
export function whatsappPhoneDigest(raw:string){const normalized=whatsappPhone(raw.startsWith('+')?raw:'+'+raw);return normalized?createHash('sha256').update(normalized).digest('hex'):null;}
export function webhookEventKey(...parts:string[]){return createHash('sha256').update(parts.join('|')).digest('hex');}
export async function whatsappOptedOut(owner:string,phoneHash:string){return withScope(owner,async c=>(await c.query('SELECT gymos.whatsapp_opted_out($1,$2) AS out',[owner,phoneHash])).rows[0]?.out===true);}
async function webhookEffect(query:WebhookQuery,sql:string,params:unknown[]){const rows=(await query(sql,params)).rows;return rows[0]?.applied===true;}
export async function consumeWhatsAppWebhook(payload:unknown,query:WebhookQuery=async(sql,params)=>({rows:(await getPool().query(sql,params)).rows as Record<string,unknown>[]})){
  const result={optouts:0,statuses:0,duplicates:0,ignored:0};
  if(!payload||typeof payload!=='object'||Array.isArray(payload))return result;
  const root=payload as {object?:unknown;entry?:unknown};
  if(root.object!=='whatsapp_business_account'||!Array.isArray(root.entry))return result;
  for(const entry of root.entry.slice(0,50)){
    if(!entry||typeof entry!=='object')continue;
    const changes=(entry as {changes?:unknown}).changes;
    if(!Array.isArray(changes))continue;
    for(const change of changes.slice(0,50)){
      if(!change||typeof change!=='object'||(change as {field?:unknown}).field!=='messages')continue;
      const value=(change as {value?:unknown}).value;
      if(!value||typeof value!=='object'||Array.isArray(value))continue;
      const v=value as {metadata?:{phone_number_id?:unknown};messages?:unknown;statuses?:unknown};
      const phoneId=typeof v.metadata?.phone_number_id==='string'&&/^[0-9]{5,30}$/.test(v.metadata.phone_number_id)?v.metadata.phone_number_id:null;
      for(const message of Array.isArray(v.messages)?v.messages.slice(0,200):[]){
        if(!message||typeof message!=='object')continue;
        const text=(message as {text?:{body?:unknown}}).text?.body;
        if(typeof text!=='string'||!/^(stop|unsubscribe|cancel|end)$/i.test(text.trim()))continue;
        const from=(message as {from?:unknown}).from,phoneHash=typeof from==='string'?whatsappPhoneDigest(from):null;
        if(!phoneHash){result.ignored++;continue;}
        const id=(message as {id?:unknown}).id;
        const key=typeof id==='string'&&id.length>0&&id.length<=255?webhookEventKey('optout',id):webhookEventKey('optout',phoneId??'',phoneHash,String((message as {timestamp?:unknown}).timestamp??''));
        if(await webhookEffect(query,'SELECT gymos.whatsapp_webhook_stop($1,$2,$3) AS applied',[phoneId,phoneHash,key]))result.optouts++;else result.duplicates++;
      }
      for(const status of Array.isArray(v.statuses)?v.statuses.slice(0,200):[]){
        if(!status||typeof status!=='object')continue;
        const id=(status as {id?:unknown}).id,state=(status as {status?:unknown}).status;
        if(typeof id!=='string'||id.length===0||id.length>255||typeof state!=='string'||!['sent','delivered','read','failed'].includes(state)){result.ignored++;continue;}
        if(await webhookEffect(query,'SELECT gymos.whatsapp_webhook_status($1,$2,$3) AS applied',[id,state,webhookEventKey('status',id,state)]))result.statuses++;else result.duplicates++;
      }
    }
  }
  return result;
}
