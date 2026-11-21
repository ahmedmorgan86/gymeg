// Bounded read for the check-in profile popup: the OPEN visits of one branch (legacy: next.visits.filter(v=>v.branch===branch&&!v.leftAt)).
// Bound (derived, not a page): gym_visit_one_open allows at most ONE open visit per member, so the answer holds at most one row per member of the club, usually the people present now.
// Exact only while every open visit is recognisable by `payload->>'leftAt' IS NULL`: a falsy non-null leftAt ('' / false / 0, which `!v.leftAt` also treats as open) is probed through a
// partial index that is empty in normal clubs and answers 'unavailable' (the caller keeps the packet comparison).
import {boundedRead,indexProbe} from './bounded-read.ts';
import {readOwnerVersion} from './member-summary-store.ts';
import type {Scope} from './member-console-source.ts';
export type OpenVisit={id:string;member:string;at:string;activeAt?:string};
export type OpenVisits={status:'ok';version:string;open:OpenVisit[]}|{status:'stale'}|{status:'unavailable';reason?:string};
export async function readOpenVisits(scope:Scope,q:{owner:string;branch:string}):Promise<OpenVisits>{
  if(!q.branch||q.branch.length>200)throw new RangeError('invalid');
  return scope(q.owner,c=>boundedRead(c,q.owner,'openvisits\u0000'+q.branch,async()=>{
    const ver=await readOwnerVersion(c,q.owner);if(ver===null)return{status:'unavailable',reason:'no-version'} as const;
    const odd=(await indexProbe(c,()=>c.query(`SELECT EXISTS(SELECT 1 FROM gymos.gym_entities WHERE owner_id=$1 AND collection='visits' AND branch=$2 AND payload->>'leftAt' IN ('','false','0')) AS x`,[q.owner,q.branch]))).rows[0] as {x:boolean};
    if(odd.x)return{status:'unavailable',reason:'falsy-leftAt'} as const;
    const rows=(await c.query(`SELECT entity_id,payload FROM gymos.gym_entities WHERE owner_id=$1 AND collection='visits' AND branch=$2 AND payload->>'leftAt' IS NULL ORDER BY position,entity_id`,[q.owner,q.branch])).rows as {entity_id:string;payload:{id?:unknown;member?:unknown;at?:unknown;activeAt?:unknown}}[];
    if(rows.some(r=>typeof r.payload.id!=='string'||typeof r.payload.member!=='string'||typeof r.payload.at!=='string'||(r.payload.activeAt!==undefined&&r.payload.activeAt!==null&&typeof r.payload.activeAt!=='string')))return{status:'unavailable',reason:'odd-shape'} as const;
    if((await readOwnerVersion(c,q.owner))!==ver)return{status:'stale'} as const;
    return{status:'ok',version:ver,open:rows.map(r=>({id:r.payload.id as string,member:r.payload.member as string,at:r.payload.at as string,...(typeof r.payload.activeAt==='string'?{activeAt:r.payload.activeAt}:{})}))} as const;
  },o=>o.status==='ok'));
}
