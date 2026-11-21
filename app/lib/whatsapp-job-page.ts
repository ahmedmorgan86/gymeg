// Default-OFF automatic WhatsApp read selector. Never sends or queues anything.
// One member page plus only those members' latest eligible visit day; no photos,
// finance, training or complete visit history. No cache: send-time consent is fresh.
import {assembleState,type Entity} from './entity-state.ts';
import {normalize} from './extensions.ts';
import {dayAt} from './domain.ts';
import {dueMessages,type WhatsAppRule} from './whatsapp.ts';
import {readOwnerVersion} from './member-summary-store.ts';
import {budgetGuard,READ_TIMEOUT_MS} from './bounded-read.ts';
import type {Scope} from './member-console-source.ts';
export const WHATSAPP_MEMBER_PAGE=250;
export type WhatsAppCursor={position:number;id:string};
type Job=ReturnType<typeof dueMessages>[number];
export type WhatsAppJobPage={status:'ok';version:string;jobs:Job[];next:WhatsAppCursor|null}|{status:'fallback';reason:string};
export async function readWhatsAppJobPage(scope:Scope,q:{owner:string;rule:WhatsAppRule;now:string;memberId?:string;after?:WhatsAppCursor;version?:string}):Promise<WhatsAppJobPage>{
 return scope(q.owner,async c=>{try{
  await c.query("SELECT set_config('statement_timeout',$1,true)",[String(READ_TIMEOUT_MS)]);
  const version=await readOwnerVersion(c,q.owner);if(version===null||q.version!==undefined&&version!==q.version)return{status:'fallback',reason:'version'};
  const meta=(await c.query('SELECT payload FROM gymos.gym_states WHERE user_id=$1',[q.owner])).rows[0] as {payload:string}|undefined;
  if(!meta)return{status:'fallback',reason:'missing'};
  const metadata=typeof meta.payload==='string'?JSON.parse(meta.payload):meta.payload;
  if(metadata._entityStorage!==1)return{status:'fallback',reason:'layout'};
  const state=normalize(assembleState(metadata,[],{}));
  if(!state.branches.some(b=>b.id===q.rule.branch))return{status:'ok',version,jobs:[],next:null};
  const rows=(await c.query(`SELECT collection,entity_id,position,branch,payload-'photo' AS payload FROM gymos.gym_entities WHERE owner_id=$1 AND collection='members' AND branch=$2 AND ($3::text IS NULL OR entity_id=$3) AND ($4::int IS NULL OR (position,entity_id)>($4,$5)) ORDER BY position,entity_id LIMIT ${WHATSAPP_MEMBER_PAGE+1}`,[q.owner,q.rule.branch,q.memberId??null,q.after?.position??null,q.after?.id??''])).rows as Entity[];
  const page=rows.slice(0,WHATSAPP_MEMBER_PAGE);
  if(page.some(r=>r.payload.id!==r.entity_id||r.payload.branch!==r.branch))return{status:'fallback',reason:'member-shape'};
  const partial=normalize(assembleState(metadata,page,{}));
  const last=new Map<string,string>();
  if(q.rule.kind==='absence'&&partial.members.length){
   const ids=partial.members.map(m=>m.id),today=dayAt(q.now,state.settings.timezone);
   // This matches the held irregular-day/at partial index. It is stricter than
   // the oracle needs, so odd data takes the exact legacy fallback, not a guess.
   const odd=(await c.query(`SELECT EXISTS(SELECT 1 FROM gymos.gym_entities WHERE owner_id=$1 AND collection='visits' AND branch=$2 AND (jsonb_typeof(payload->'day') IS DISTINCT FROM 'string' OR payload->>'day' !~ '^\\d{4}-\\d\\d-\\d\\d$' OR jsonb_typeof(payload->'at') IS DISTINCT FROM 'string' OR payload->>'at' !~ '^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$')) AS x`,[q.owner,q.rule.branch])).rows[0] as {x:boolean};
   if(odd.x)return{status:'fallback',reason:'visit-day'};
   // At most one indexed reverse-day probe per selected member. Requires held
   // 20261121230000 index; actual hash collisions still receive exact equality.
   const grouped=(await c.query(`SELECT selected.member,h.day FROM unnest($3::text[]) AS selected(member) CROSS JOIN LATERAL (
    SELECT (payload->>'day') COLLATE "C" AS day FROM gymos.gym_entities
    WHERE owner_id=$1 AND collection='visits' AND branch=$2
     AND md5(payload->>'member')=md5(selected.member) AND payload->>'member'=selected.member AND jsonb_typeof(payload->'member')='string'
     AND payload->>'day' ~ '^\\d{4}-\\d\\d-\\d\\d$' AND (payload->>'day') COLLATE "C" <= ($4::text COLLATE "C")
    ORDER BY (payload->>'day') COLLATE "C" DESC LIMIT 1
   ) h`,[q.owner,q.rule.branch,ids,today])).rows as {member:string;day:string|null}[];
   for(const r of grouped)if(r.day!==null)last.set(r.member,r.day);
  }
  const jobs=dueMessages(partial,q.rule,q.now,last);
  if((await readOwnerVersion(c,q.owner))!==version)return{status:'fallback',reason:'changed'};
  const end=page.at(-1);return{status:'ok',version,jobs,next:rows.length>WHATSAPP_MEMBER_PAGE&&end?{position:end.position,id:end.entity_id}:null};
 }catch(e){return budgetGuard(e);}});
}
