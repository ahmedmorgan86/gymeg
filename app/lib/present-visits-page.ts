// Exact bounded Operations presence rows, not the check-in popup's open rows.
// Legacy selects latest eligible visit INCLUDING closed rows, then filters open.
// It preserves member first-occurrence order, not latest-visit order. Histories
// over the explicit caps refuse, leaving full-packet fallback in place.
import {boundedRead,indexProbe} from './bounded-read.ts';
import {readOwnerVersion} from './member-summary-store.ts';
import type {Scope} from './member-console-source.ts';
import type {GymState} from './domain.ts';
export const PRESENT_OPEN_CAP=1000,PRESENT_HISTORY_CAP=256,PRESENT_TOTAL_CAP=10000;
export async function readPresentVisits(scope:Scope,q:{owner:string;branch:string;now:string;autoExitMinutes:number}){
 const stamp=Date.parse(q.now);if(!q.branch||q.branch.length>200||!Number.isFinite(stamp)||!Number.isFinite(q.autoExitMinutes)||q.autoExitMinutes<=0)throw new RangeError('invalid');
 const now=new Date(stamp).toISOString();
 return scope(q.owner,c=>boundedRead(c,q.owner,'present\u0000'+q.branch+'\u0000'+now+'\u0000'+q.autoExitMinutes,async()=>{
  const version=await readOwnerVersion(c,q.owner);if(version===null)return{status:'unavailable',reason:'version'} as const;
  const odd=(await indexProbe(c,()=>c.query(`SELECT EXISTS(SELECT 1 FROM gymos.gym_entities WHERE owner_id=$1 AND collection='visits' AND branch=$2 AND (NOT gymos.canonical_visit_clock(payload) OR jsonb_typeof(payload->'member') IS DISTINCT FROM 'string' OR jsonb_typeof(payload->'leftAt') IN ('number','boolean','object','array') OR payload->>'leftAt'='')) AS x`,[q.owner,q.branch]))).rows[0] as {x:boolean};
  if(odd.x)return{status:'unavailable',reason:'shape'} as const;
  const open=(await c.query(`SELECT payload->>'member' AS member FROM gymos.gym_entities WHERE owner_id=$1 AND collection='visits' AND branch=$2 AND payload->>'leftAt' IS NULL ORDER BY position,entity_id LIMIT ${PRESENT_OPEN_CAP+1}`,[q.owner,q.branch])).rows as {member:string}[];
  if(open.length>PRESENT_OPEN_CAP)return{status:'unavailable',reason:'open-cap'} as const;
  const ids=[...new Set(open.map(r=>r.member))];
  const rows=ids.length?(await c.query(`SELECT selected.member,v.payload,v.position FROM unnest($3::text[]) selected(member) CROSS JOIN LATERAL (SELECT payload,position,entity_id FROM gymos.gym_entities WHERE owner_id=$1 AND collection='visits' AND branch=$2 AND demand_member_hash=md5(selected.member) AND payload->>'member'=selected.member AND jsonb_typeof(payload->'member')='string' AND demand_visit_clock IS NOT NULL AND demand_visit_clock <= ($4::text COLLATE "C") ORDER BY demand_visit_clock DESC,position LIMIT ${PRESENT_HISTORY_CAP+1}) v LIMIT ${PRESENT_TOTAL_CAP+1}`,[q.owner,q.branch,ids,now])).rows as {member:string;payload:GymState['visits'][number];position:number}[]:[];
  if(rows.length>PRESENT_TOTAL_CAP)return{status:'unavailable',reason:'total-cap'} as const;
  const groups=new Map<string,typeof rows>();for(const r of rows){const a=groups.get(r.member)??[];a.push(r);groups.set(r.member,a);}
  const selected:{visit:GymState['visits'][number];first:number}[]=[];
  for(const group of groups.values()){
   if(group.length>PRESENT_HISTORY_CAP)return{status:'unavailable',reason:'history-cap'} as const;
   group.sort((a,b)=>Date.parse(b.payload.activeAt??b.payload.at)-Date.parse(a.payload.activeAt??a.payload.at)||a.position-b.position);
   const seen=new Set<number>();for(const r of group){if(seen.has(r.position))return{status:'unavailable',reason:'position-tie'} as const;seen.add(r.position);if(typeof r.payload.id!=='string'||r.payload.branch!==q.branch)return{status:'unavailable',reason:'identity'} as const;}
   const top=group[0],clock=top.payload.activeAt??top.payload.at;
   if(!top.payload.leftAt&&stamp-Date.parse(clock)<q.autoExitMinutes*60000)selected.push({visit:top.payload,first:Math.min(...group.map(r=>r.position))});
  }
  selected.sort((a,b)=>a.first-b.first);if(selected.some((r,i)=>i>0&&r.first===selected[i-1].first))return{status:'unavailable',reason:'position-tie'} as const;
  if((await readOwnerVersion(c,q.owner))!==version)return{status:'stale'} as const;
  return{status:'ok',version,present:selected.map(r=>r.visit)} as const;
 },r=>r.status==='ok'));
}
