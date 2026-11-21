// Server side of the (OFF by default) member detail source: the selected member's own rows only, never the club's.
import {readCounters} from './workspace-slice.ts';
import {computeStoredSummary,type StoredSummary} from './member-summary-model.ts';
import type {GymState,Member} from './domain.ts';
type Invoice=NonNullable<GymState['invoices']>[number];type Payment=GymState['payments'][number];
import type {Scope} from './member-console-source.ts';

export type DetailResponse=
  |{status:'ok';stored:StoredSummary;invoices:Invoice[];payments:Payment[]}
  |{status:'notFound'}|{status:'forbidden'}|{status:'fallback';reason:string};
type Q={owner:string;member:string;branches:string[]|null;financial:boolean;settings:GymState['settings'];asOf?:string};

/** `stored` is the member's summary computed over EVERY branch the caller can see: that is the view memberSummary(packetState,member) has in the detail panel
 * (the list uses the member's own branch only). The client derives time-sensitive fields from it exactly as for the list. Invoices come back non-voided in
 * legacy order (what memberSummary(...).invoices is). Payments and invoices are only read for a caller whose packet would carry them. */
export async function readMemberDetail(scope:Scope,q:Q):Promise<DetailResponse>{
  if(!q.member||q.member.length>200)return{status:'fallback',reason:'invalid-member'};
  return scope(q.owner,async c=>{
    const k=await readCounters(c as never,q.owner);if(!k)return{status:'fallback',reason:'counters-unready'} as const;
    const br=q.branches?' AND branch=ANY($3::text[])':'';
    const rows=async(coll:string,limit:number,member?:boolean)=>{
      const args:unknown[]=member?[q.owner,q.member]:[q.owner,q.member];if(q.branches)args.push(q.branches);
      return (await c.query(`SELECT payload FROM gymos.gym_entities WHERE owner_id=$1 AND collection='${coll}' AND ${coll==='members'?'entity_id':"payload->>'member'"}=$2${br} ORDER BY position,entity_id LIMIT ${limit+1}`,args)).rows.map(r=>(r as {payload:unknown}).payload);
    };
    const m=(await rows('members',1))[0] as Member|undefined;
    if(!m)return{status:'notFound'} as const;
    // the counters give an exact per-collection row count of the owner, so a member can never legitimately have more rows than that
    const cap=(coll:string)=>Number(k.counts[coll]??0);
    const visits=await rows('visits',cap('visits')),payments=q.financial?await rows('payments',cap('payments')):[],invoices=q.financial?await rows('invoices',cap('invoices')):[];
    if(visits.length>cap('visits')||payments.length>cap('payments')||invoices.length>cap('invoices'))return{status:'fallback',reason:'raced'} as const;
    const mini={settings:q.settings,members:[m],visits,payments,invoices,plans:[]} as unknown as GymState;
    const stored=computeStoredSummary(mini,m,q.asOf,{allBranches:true});
    return{status:'ok',stored,invoices:(invoices as Invoice[]).filter(i=>!i.voided),payments:payments as Payment[]} as const;
  });
}

/** The clock a detail summary is computed at. The caller's screen clock may only move it back by one day (the stored horizon is a UTC day, so a screen at most a day
 * behind the server still derives exactly); anything older, later, malformed or non-canonical is ignored and the server clock is used, which keeps the stored
 * tail (and the response) bounded to the recent day instead of a client-chosen amount of history. Timestamps are compared as instants, never as strings. */
export const ASOF_MAX_SKEW_MS=86400000;
export function detailAsOf(asOf:string|undefined|null,nowMs:number):string{
  const now=new Date(nowMs).toISOString();
  if(!asOf)return now;
  const t=Date.parse(asOf);
  if(!Number.isFinite(t)||t>nowMs||nowMs-t>ASOF_MAX_SKEW_MS)return now;
  return new Date(t).toISOString();
}
