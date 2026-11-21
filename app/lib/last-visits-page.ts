// Bounded read for the manual WhatsApp reminders: the latest visit day <= today of each member of one branch.
// Legacy (manualWhatsAppDue): for (v of visits) if (v.branch===branch && v.day<=today && v.day>(last.get(v.member)??'')) last.set(v.member,v.day)  (JS code-unit string compare).
// Here: one grouped aggregate over the branch's canonical-day visits, with COLLATE "C" (= code-unit order for ASCII). Transfer is O(members that visited), not O(visits); the scan is
// proportional to the branch's visits up to today (measured, guarded by the statement timeout), NOT bounded by a page.
// Not exact => 'unavailable' (the caller keeps the packet expression): any visit of the branch with a non-canonical day or `at` (the same irregular partial index the attendance page probes),
// or a non-string member.
import {boundedRead} from './bounded-read.ts';
import {readOwnerVersion} from './member-summary-store.ts';
import type {Scope} from './member-console-source.ts';
export type LastVisits={status:'ok';version:string;last:Record<string,string>}|{status:'stale'}|{status:'unavailable';reason?:string};
export async function readLastVisits(scope:Scope,q:{owner:string;branch:string;today:string}):Promise<LastVisits>{
  if(!q.branch||q.branch.length>200||!/^\d{4}-\d\d-\d\d$/.test(q.today))throw new RangeError('invalid');
  return scope(q.owner,c=>boundedRead(c,q.owner,'lastvisits\u0000'+q.branch+'\u0000'+q.today,async()=>{
    const ver=await readOwnerVersion(c,q.owner);if(ver===null)return{status:'unavailable',reason:'no-version'} as const;
    const odd=(await c.query(`SELECT EXISTS(SELECT 1 FROM gymos.gym_entities WHERE owner_id=$1 AND collection='visits' AND branch=$2 AND (jsonb_typeof(payload->'day') IS DISTINCT FROM 'string' OR payload->>'day' !~ '^\\d{4}-\\d\\d-\\d\\d$' OR jsonb_typeof(payload->'at') IS DISTINCT FROM 'string' OR payload->>'at' !~ '^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$')) AS x`,[q.owner,q.branch])).rows[0] as {x:boolean};
    if(odd.x)return{status:'unavailable',reason:'non-canonical-visit'} as const;
    const rows=(await c.query(`SELECT payload->>'member' AS m,jsonb_typeof(payload->'member') AS t,max((payload->>'day') COLLATE "C") AS d FROM gymos.gym_entities WHERE owner_id=$1 AND collection='visits' AND branch=$2 AND payload->>'day' ~ '^\\d{4}-\\d\\d-\\d\\d$' AND (payload->>'day') COLLATE "C" <= ($3::text COLLATE "C") GROUP BY 1,2`,[q.owner,q.branch,q.today])).rows as {m:string|null;t:string|null;d:string}[];
    if(rows.some(r=>r.t!=='string'))return{status:'unavailable',reason:'non-string-member'} as const;
    if((await readOwnerVersion(c,q.owner))!==ver)return{status:'stale'} as const;
    return{status:'ok',version:ver,last:Object.fromEntries(rows.map(r=>[r.m!,r.d]))} as const;
  },o=>o.status==='ok'));
}
