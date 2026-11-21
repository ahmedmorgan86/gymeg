// Bounded read for the Operations "Outstanding balances" tab. Legacy: every invoice of the branch (optionally one member) in packet order, the headline total
// `invoices.reduce(outstanding)`, and per-row outstanding = voided?0:total-sum(allocations whose payment exists, is not voided and has the invoice's member and branch).
// Here: the headline total as one SQL aggregate (cost proportional to the branch's invoices and allocations, NOT bounded by a page; measured, guarded by the statement timeout),
// and the rows in keyset pages of DUES_PAGE (position, entity_id) with the same arithmetic. Pages carry the owner version of page 1 (stale => browser restarts).
import {boundedRead} from './bounded-read.ts';
import {readOwnerVersion} from './member-summary-store.ts';
import type {Scope} from './member-console-source.ts';
export const DUES_PAGE=50; // transfer chunk (judgment), not a limit: the page keeps offering the next chunk
export type DueRow={invoice:Record<string,unknown>;outstanding:number;name:string|null;allocations:{payment:string;found:boolean;day:string|null;method:string|null;voided:boolean|null}[]};
export type Cursor={pos:number;id:string};
export type DuesData={status:'ok';version:string;total?:number;rows:DueRow[];next:Cursor|null}|{status:'stale'}|{status:'unavailable'};
const OUT=`CASE WHEN COALESCE(i.payload->>'voided','false')='true' THEN 0 ELSE (i.payload->>'total')::numeric - COALESCE((SELECT sum((a->>'minor')::numeric) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.payload->'allocations')='array' THEN i.payload->'allocations' ELSE '[]'::jsonb END) a WHERE EXISTS(SELECT 1 FROM gymos.gym_entities p WHERE p.owner_id=i.owner_id AND p.collection='payments' AND p.entity_id=a->>'payment' AND COALESCE(p.payload->>'voided','false')<>'true' AND p.payload->>'member'=i.payload->>'member' AND p.payload->>'branch'=i.payload->>'branch')),0) END`;
export async function readDues(scope:Scope,q:{owner:string;branch:string;member?:string;after?:Cursor;ver?:string}):Promise<DuesData>{
  if(!q.branch||q.branch.length>200||(q.member!==undefined&&(!q.member||q.member.length>200))||(q.after!==undefined&&(!Number.isSafeInteger(q.after.pos)||!q.after.id||q.after.id.length>200||typeof q.ver!=='string')))throw new RangeError('invalid');
  return scope(q.owner,c=>boundedRead(c,q.owner,'dues\u0000'+q.branch+'\u0000'+(q.member??'')+'\u0000'+(q.after?q.after.pos+'\u0000'+q.after.id+'\u0000'+q.ver:''),async()=>{
    const ver=await readOwnerVersion(c,q.owner);if(ver===null)return{status:'unavailable'} as const;
    if(q.after&&q.ver!==ver)return{status:'stale'} as const;
    const mem=q.member!==undefined,args:unknown[]=[q.owner,q.branch,...(mem?[q.member]:[])],M=mem?" AND i.payload->>'member'=$3":'';
    const total=q.after?undefined:Number(((await c.query(`SELECT COALESCE(sum(${OUT}),0)::text AS n FROM gymos.gym_entities i WHERE i.owner_id=$1 AND i.collection='invoices' AND i.branch=$2${M}`,args)).rows[0] as {n:string}).n);
    const k=args.length;const cur=q.after?` AND (i.position,i.entity_id)>($${k+1}::bigint,$${k+2}::text)`:'';
    if(q.after)args.push(q.after.pos,q.after.id);
    const rows=(await c.query(`SELECT i.payload,i.position,i.entity_id,(${OUT})::text AS outstanding,(SELECT m.payload->>'name' FROM gymos.gym_entities m WHERE m.owner_id=i.owner_id AND m.collection='members' AND m.entity_id=i.payload->>'member' AND m.branch=$2 AND COALESCE(m.payload->>'archived','false')<>'true') AS name,(SELECT COALESCE(jsonb_agg(jsonb_build_object('payment',a->>'payment','found',p.entity_id IS NOT NULL,'day',p.payload->'day','method',p.payload->'method','voided',p.payload->'voided') ORDER BY ord),'[]'::jsonb) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.payload->'allocations')='array' THEN i.payload->'allocations' ELSE '[]'::jsonb END) WITH ORDINALITY x(a,ord) LEFT JOIN gymos.gym_entities p ON p.owner_id=i.owner_id AND p.collection='payments' AND p.entity_id=a->>'payment') AS allocs FROM gymos.gym_entities i WHERE i.owner_id=$1 AND i.collection='invoices' AND i.branch=$2${M}${cur} ORDER BY i.position,i.entity_id LIMIT ${DUES_PAGE+1}`,args)).rows as {payload:Record<string,unknown>;position:number;entity_id:string;outstanding:string;name:string|null;allocs:DueRow['allocations']}[];
    if((await readOwnerVersion(c,q.owner))!==ver)return{status:'stale'} as const;
    const more=rows.length>DUES_PAGE,page=more?rows.slice(0,DUES_PAGE):rows,last=page[page.length-1];
    return{status:'ok',version:ver,...(total!==undefined?{total}:{}),rows:page.map(r=>({invoice:r.payload,outstanding:Number(r.outstanding),name:r.name,allocations:r.allocs})),next:more?{pos:Number(last.position),id:last.entity_id}:null} as const;
  },o=>o.status==='ok'));
}
