// Held member message partial mutation. Community metadata remains complete;
// every referenced message member is hydrated for validateCommunity exactness.
import {consistently,type SliceBackend} from './workspace-slice.ts';
import {assembleState} from './entity-state.ts';
import {normalize} from './extensions.ts';
import {communityMessage,emptyCommunity,validateCommunity} from './community.ts';
import {persistSpace,SliceConflict} from './entity-store.ts';
import {RECENT_EVENTS} from './activity-archive.ts';
import {dayAt,type GymState} from './domain.ts';
export async function tryMemberMessageSlice(be:SliceBackend,q:{owner:string;member:string;branch:string;requestId:string;text:string;now:string;newId:()=>string}){
 if(process.env.GYMOS_MEMBER_MESSAGE_READS!=='1'||!be.supportsOpen)return null;
 const got=await consistently(be,q.owner,async meta=>{
  if(meta.metadata._activityArchive!==1)return null;
  const messages=(meta.metadata.community as GymState['community'])?.messages??[];
  if(messages.some(m=>typeof m.member!=='string'))return null;
  const ids=[...new Set([q.member,...messages.map(m=>m.member)])];
  if(ids.length>1000)return null; // explicit retained full-path case, never truncated
  const k=await be.counters(q.owner);if(!k||(k.counts.events??0)>=RECENT_EVENTS)return null;
  const rows=await be.entities(q.owner,{collections:['members'],ids});
  return{state:normalize(assembleState(meta.metadata,rows,{})),positions:Object.fromEntries(rows.map(e=>[e.collection+':'+e.entity_id,e.position]))};
 });
 if(!got?.value)return null;const current={state:got.value.state,revision:got.revision};
 const member=current.state.members.find(m=>m.id===q.member&&m.branch===q.branch&&!m.demo&&!m.archived);
 if(!member)return{status:404,body:{error:'notLinked'},notify:false} as const;
 const next=structuredClone(current.state),c=next.community??=emptyCommunity(),id=member.id+':'+q.requestId,old=c.messages.find(x=>x.id===id);
 if(old)return old.member===member.id&&old.text===q.text?{status:200,body:{ok:true,duplicate:true},notify:false} as const:{status:409,body:{error:'replay'},notify:false} as const;
 const today=dayAt(q.now,next.settings.timezone);
 if(c.messages.filter(x=>x.member===member.id&&x.side==='member'&&dayAt(x.at,next.settings.timezone)===today).length>=10)return{status:429,body:{error:'rateLimit'},notify:false} as const;
 c.messages.push(communityMessage.parse({id,branch:q.branch,member:q.member,side:'member',actor:q.member,text:q.text,at:q.now}));
 validateCommunity(next);next.events.push({id:q.newId(),branch:q.branch,at:q.now,kind:'community.member.message',subject:q.member,actor:q.member});
 try{if(!await persistSpace(q.owner,current,next,false,{positions:got.value.positions,trims:[{collection:'events',keep:RECENT_EVENTS}]}))return{status:409,body:{error:'conflict'},notify:false} as const;}catch(e){if(e instanceof SliceConflict)return null;throw e;}
 return{status:200,body:{ok:true},notify:true,id} as const;
}
