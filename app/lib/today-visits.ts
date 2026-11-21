// Bounded "today at this branch" reads for the daily home count and the operations "latest visits" list. Reads only that branch-day's visits (index
// gym_entities_visit_branch_day, held migration 20261121200000), never the club's history. Pure over an injected owner scope.
import type {Scope} from './member-console-source.ts';
export type TodayVisits={count:number;latest:{id:string;member:string;at:string;activeAt?:string;name:string|null}[]};
export const TODAY_LATEST=12;
/** count: legacy `visits.filter(v=>v.branch===branch&&v.day===today&&members.some(m=>m.id===v.member)).length` where members are the branch's non-archived, non-demo members.
 *  latest: legacy `visits.filter(v=>v.branch===branch&&v.day===today).slice(-12).reverse()` (last 12 by position, newest first); `name` is the member's name when the
 *  member is a non-archived member of the branch (the operations screen's lookup), else null (the screen then shows the member id). */
export async function readTodayVisits(scope:Scope,q:{owner:string;branch:string;day:string}):Promise<TodayVisits>{
  if(!q.branch||q.branch.length>200||!/^\d{4}-\d\d-\d\d$/.test(q.day))throw new RangeError('invalid');
  return scope(q.owner,async c=>{
    const count=Number(((await c.query(`SELECT count(*)::int AS n FROM gymos.gym_entities v WHERE v.owner_id=$1 AND v.collection='visits' AND v.branch=$2 AND v.payload->>'day'=$3 AND EXISTS(SELECT 1 FROM gymos.gym_entities m WHERE m.owner_id=v.owner_id AND m.collection='members' AND m.entity_id=v.payload->>'member' AND m.branch=$2 AND COALESCE(m.payload->>'archived','false')<>'true' AND COALESCE(m.payload->>'demo','false')<>'true')`,[q.owner,q.branch,q.day])).rows[0] as {n:number}).n);
    const rows=(await c.query(`SELECT v.payload,(SELECT m.payload->>'name' FROM gymos.gym_entities m WHERE m.owner_id=v.owner_id AND m.collection='members' AND m.entity_id=v.payload->>'member' AND m.branch=$2 AND COALESCE(m.payload->>'archived','false')<>'true') AS name FROM gymos.gym_entities v WHERE v.owner_id=$1 AND v.collection='visits' AND v.branch=$2 AND v.payload->>'day'=$3 ORDER BY v.position DESC,v.entity_id DESC LIMIT ${TODAY_LATEST}`,[q.owner,q.branch,q.day])).rows as {payload:{id:string;member:string;at:string;activeAt?:string};name:string|null}[];
    return{count,latest:rows.map(r=>({id:r.payload.id,member:r.payload.member,at:r.payload.at,...(r.payload.activeAt!==undefined?{activeAt:r.payload.activeAt}:{}),name:r.name}))};
  });
}
