// Bounded read for the manual WhatsApp reminders: the latest visit day <= today of each member of one branch.
// Legacy (manualWhatsAppDue): for (v of visits) if (v.branch===branch && v.day<=today && v.day>(last.get(v.member)??'')) last.set(v.member,v.day)  (JS code-unit string compare).
// Here: for each member of the branch, an index probe for the newest canonical day <= today (COLLATE "C" = code-unit order for ASCII). Cost O(members x log visits), transfer O(members).
// Not exact => 'unavailable' (the caller keeps the packet expression): any visit of the branch with a non-canonical day or `at` (the same irregular partial index the attendance page probes),
// (a member whose visits use a non-string `member` value matches no probe and is never read by the caller).
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
    // One probe per member of the branch (the only groups the caller reads; ghost or other-branch member groups of the legacy map are never looked up). The member key is matched with
    // md5 (index key size) AND the exact equality, the day with the canonical predicate and COLLATE "C" exactly as the index declares.
    const rows=(await c.query(`SELECT m.entity_id AS m,l.d AS d FROM gymos.gym_entities m CROSS JOIN LATERAL (SELECT (v.payload->>'day') COLLATE "C" AS d FROM gymos.gym_entities v WHERE v.owner_id=m.owner_id AND v.collection='visits' AND md5(v.payload->>'member')=md5(m.entity_id) AND v.payload->>'member'=m.entity_id AND v.branch=$2 AND v.payload->>'day' ~ '^\\d{4}-\\d\\d-\\d\\d$' AND (v.payload->>'day') COLLATE "C" <= ($3::text COLLATE "C") ORDER BY (v.payload->>'day') COLLATE "C" DESC LIMIT 1) l WHERE m.owner_id=$1 AND m.collection='members' AND m.branch=$2`,[q.owner,q.branch,q.today])).rows as {m:string;d:string}[];
    if((await readOwnerVersion(c,q.owner))!==ver)return{status:'stale'} as const;
    return{status:'ok',version:ver,last:Object.fromEntries(rows.map(r=>[r.m!,r.d]))} as const;
  },o=>o.status==='ok'));
}
