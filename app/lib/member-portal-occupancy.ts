// Portal occupancy only: no complete history of other present members.
// Requires held canonical_visit_clock + reverse clock index. Conservative
// refusal leaves the existing exact memberView hydration path in place.
import type {Scope} from './member-console-source.ts';
import {readOwnerVersion} from './member-summary-store.ts';
import {deadlineScope} from './deadline-scope.ts';
import {indexProbe} from './bounded-read.ts';
export const PORTAL_OPEN_CAP=2000;
export async function readPortalOccupancy(scope:Scope,q:{owner:string;branch:string;now:string;autoExitMinutes:number}){
 const stamp=Date.parse(q.now),now=new Date(stamp).toISOString();
 return deadlineScope(scope,Date.now()+4000)(q.owner,async c=>{
  const version=await readOwnerVersion(c,q.owner);if(version===null)return{status:'unavailable',reason:'version'} as const;
  const odd=(await indexProbe(c,()=>c.query("SELECT EXISTS(SELECT 1 FROM gymos.gym_entities WHERE owner_id=$1 AND collection='visits' AND branch=$2 AND NOT gymos.canonical_visit_clock(payload)) AS x",[q.owner,q.branch]))).rows[0] as {x:boolean};
  if(odd.x)return{status:'unavailable',reason:'clock'} as const;
  const left=(await indexProbe(c,()=>c.query("SELECT EXISTS(SELECT 1 FROM gymos.gym_entities WHERE owner_id=$1 AND collection='visits' AND branch=$2 AND (jsonb_typeof(payload->'leftAt') IN ('number','boolean','object','array') OR payload->>'leftAt'='')) AS x",[q.owner,q.branch]))).rows[0] as {x:boolean};
  if(left.x)return{status:'unavailable',reason:'leftAt'} as const;
  const open=(await c.query(`SELECT v.payload->'member' AS member,m.payload->'id' AS id,m.payload->'branch' AS branch,m.payload->'demo' AS demo,m.payload->'archived' AS archived FROM gymos.gym_entities v JOIN gymos.gym_entities m ON m.owner_id=v.owner_id AND m.collection='members' AND m.entity_id=v.payload->>'member' AND m.branch=$2 WHERE v.owner_id=$1 AND v.collection='visits' AND v.branch=$2 AND v.payload->>'leftAt' IS NULL ORDER BY v.position,v.entity_id LIMIT ${PORTAL_OPEN_CAP+1}`,[q.owner,q.branch])).rows as {member:unknown;id:unknown;branch:unknown;demo:unknown;archived:unknown}[];
  if(open.length>PORTAL_OPEN_CAP)return{status:'unavailable',reason:'open-cap'} as const;
  if(open.some(r=>typeof r.member!=='string'||r.id!==r.member||r.branch!==q.branch))return{status:'unavailable',reason:'member-shape'} as const;
  const ids=[...new Set(open.filter(r=>!r.demo&&!r.archived).map(r=>r.member as string))];
  const latest=ids.length?(await c.query(`SELECT selected.member,v.payload,v.position FROM unnest($3::text[]) selected(member) CROSS JOIN LATERAL (SELECT payload,position,entity_id FROM gymos.gym_entities WHERE owner_id=$1 AND collection='visits' AND branch=$2 AND md5(payload->>'member')=md5(selected.member) AND payload->>'member'=selected.member AND jsonb_typeof(payload->'member')='string' AND gymos.canonical_visit_clock(payload) AND (COALESCE(payload->>'activeAt',payload->>'at')) COLLATE "C" <= ($4::text COLLATE "C") ORDER BY (COALESCE(payload->>'activeAt',payload->>'at')) COLLATE "C" DESC,position,entity_id LIMIT 2) v ORDER BY selected.member,(COALESCE(v.payload->>'activeAt',v.payload->>'at')) COLLATE "C" DESC,v.position,v.entity_id`,[q.owner,q.branch,ids,now])).rows as {member:string;payload:{at:string;activeAt?:string;leftAt?:unknown};position:number}[]:[];
  let occupancy=0;const groups=new Map<string,typeof latest>();for(const r of latest){const group=groups.get(r.member)??[];group.push(r);groups.set(r.member,group);}
  for(const rows of groups.values()){
   const first=rows[0],second=rows[1],clock=first.payload.activeAt??first.payload.at;
   // Duplicate positions at identical clocks have no stable legacy ordering.
   if(second&&clock===(second.payload.activeAt??second.payload.at)&&first.position===second.position)return{status:'unavailable',reason:'tie'} as const;
   if(!first.payload.leftAt&&stamp-Date.parse(clock)<q.autoExitMinutes*60000)occupancy++;
  }
  if((await readOwnerVersion(c,q.owner))!==version)return{status:'unavailable',reason:'changed'} as const;
  return{status:'ok',version,occupancy} as const;
 });
}
