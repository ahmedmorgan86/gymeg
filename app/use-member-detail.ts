"use client";
// Detail source for the selected member. OFF (default): the legacy memberSummary over the packet state. ON (NEXT_PUBLIC_GYMOS_MEMBER_SUMMARIES=1): that member's stored
// summary, payments and invoices fetched on demand; the summary's time-sensitive fields are derived with the screen clock. Anything inexact keeps the legacy path.
import {useCallback,useEffect,useState} from 'react';
import {LAZY_STRICT} from './use-attendance';
import type {GymState,Member} from './lib/domain';
import {deriveSummary,type StoredSummary} from './lib/member-summary-model';
import {memberSummary} from './lib/member-console';
import {SUMMARIES_ON} from './use-console-index';
type Detail={owner:string;member:string;forState:GymState;stored:StoredSummary;invoices:GymState['invoices'];payments:GymState['payments']};
export type DetailView={x:ReturnType<typeof memberSummary>;visitCount:number;payments:GymState['payments'];source:'legacy'|'detail'};
/** `hold`: also accept the last detail of the SAME owner and member fetched for an earlier state object (strict mode, while the newer state refetches). Any other owner or member never matches. */
export function chooseDetail(on:boolean,d:Detail|null,state:GymState,m:Member,owner:string,now:string,hold=false):DetailView{
  if(on&&d&&d.owner===owner&&d.member===m.id&&(d.forState===state||hold)){
    const x=deriveSummary(d.stored,m,state.settings,now);
    if(x)return{x:{...x,plan:state.plans?.find(p=>p.id===x.period?.plan),invoices:d.invoices??[]} as unknown as ReturnType<typeof memberSummary>,visitCount:d.stored.visitCount,payments:d.payments,source:'detail'};
  }
  const x=memberSummary(state,m,now);
  return{x,visitCount:state.visits.filter(v=>v.member===m.id).length,payments:state.payments.filter(a=>a.member===m.id),source:'legacy'};
}
/** Visit count for display. Strict (packet may omit visits): the legacy fallback would count an empty list, so an unknown count is null (the caller shows a dash), never 0. */
export function visitCountView(view:Pick<DetailView,'visitCount'|'source'>,strict:boolean):number|null{return strict&&view.source==='legacy'?null:view.visitCount;}
/** Strict (LAZY_STRICT, the packet may omit visits): a legacy summary is computed from an empty list (full quota, no open visit, zero visits), so it is unknown, never shown. */
export const detailUnknown=(view:Pick<DetailView,'source'>,strict:boolean)=>strict&&view.source==='legacy';
export function useMemberDetail(state:GymState,m:Member,owner:string,now:string):DetailView&{failed:boolean;retry:()=>void}{
  const [d,setD]=useState<Detail|null>(null),[failedFor,setFailedFor]=useState<GymState|null>(null),[bump,setBump]=useState(0);
  useEffect(()=>{
    if(!SUMMARIES_ON)return;
    setFailedFor(null);
    const ac=new AbortController();
    (async()=>{try{
      const get=async(asOf?:string)=>{const r=await fetch('/api/workspace/member-detail?member='+encodeURIComponent(m.id)+(asOf?'&asOf='+encodeURIComponent(asOf):''),{headers:{'X-GymOS-Tenant':owner},signal:ac.signal,cache:'no-store'});return r.ok?await r.json() as {status:string;stored?:StoredSummary;invoices?:Detail['invoices'];payments?:Detail['payments']}:null;};
      let j=await get();
      if(j?.status==='ok'&&j.stored&&deriveSummary(j.stored,m,state.settings,now)===null)j=await get(now); // the screen clock is behind the server's: recompute at that clock
      if(j?.status==='ok'&&j.stored){setD({owner,member:m.id,forState:state,stored:j.stored,invoices:j.invoices??[],payments:j.payments??[]});setFailedFor(null);}else setFailedFor(state); // keep the last good detail: strict mode shows it (same owner and member only) instead of flashing unknown
    }catch{if(!ac.signal.aborted)setFailedFor(state);}})();
    return()=>ac.abort();
  },[owner,m.id,state,bump]); // eslint-disable-line react-hooks/exhaustive-deps -- `now` ticks every second; the fetch follows state changes only
  const retry=useCallback(()=>setBump(n=>n+1),[]);
  return{...chooseDetail(SUMMARIES_ON,d,state,m,owner,now,LAZY_STRICT),failed:SUMMARIES_ON&&failedFor!==null&&failedFor===state,retry};
}
