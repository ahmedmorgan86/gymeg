"use client";
// OFF (default): the Overview counts and attendance pulse keep filtering the packet's visits. ON (NEXT_PUBLIC_GYMOS_VISIT_TREND=1): per-day visit counts of the branch from the server,
// used only when fetched for THIS state object, owner, branch, day and period; null otherwise (caller keeps the packet expression).
import {useCallback,useEffect,useState} from 'react';
import {REFETCH_DEBOUNCE_MS,LAZY_STRICT} from './use-attendance';
import type {GymState} from './lib/domain';
export const VISIT_TREND_ON=process.env.NEXT_PUBLIC_GYMOS_VISIT_TREND==='1';
type Got={owner:string;branch:string;today:string;period:number;forState:GymState;days:Record<string,number>};
export function chooseVisitTrend(on:boolean,got:Got|null,state:GymState,owner:string,branch:string,today:string,period:number):Record<string,number>|null{
  return on&&got&&got.owner===owner&&got.branch===branch&&got.today===today&&got.period===period&&got.forState===state?got.days:null;
}
/** Last good counts for the same owner, branch, day and period (any earlier state object): shown while a refetch for a newer state is in flight, so strict mode does not flash zeros after each mutation. */
export function heldVisitTrend(got:Got|null,owner:string,branch:string,today:string,period:number):Record<string,number>|null{
  return got&&got.owner===owner&&got.branch===branch&&got.today===today&&got.period===period?got.days:null;
}
export {LAZY_STRICT};
export function useVisitTrend(state:GymState|undefined,owner:string|undefined,branch:string,today:string,period:number):{days:Record<string,number>|null;held:Record<string,number>|null;failed:boolean;unavailable:boolean;retry:()=>void}{
  const [got,setGot]=useState<Got|null>(null),[failedFor,setFailedFor]=useState<GymState|null>(null),[bump,setBump]=useState(0),[unavailFor,setUnavailFor]=useState<GymState|null>(null);
  const retry=useCallback(()=>setBump(n=>n+1),[]);
  useEffect(()=>{
    if(!VISIT_TREND_ON||!owner||!state)return;const ac=new AbortController();
    const fail=()=>{if(!ac.signal.aborted){setFailedFor(state);}};
    const timer=setTimeout(()=>{(async()=>{try{
      const r=await fetch('/api/workspace/visit-trend?branch='+encodeURIComponent(branch)+'&today='+today+'&period='+period,{headers:{'X-GymOS-Tenant':owner},signal:ac.signal,cache:'no-store'});
      const d=r.ok?await r.json() as {status?:string;reason?:string;days?:Record<string,number>}:null;
      if(d&&d.status==='unavailable'){if(!ac.signal.aborted){setUnavailFor(state);setFailedFor(null);}return;} // data the server cannot count exactly: a retry cannot help
      if(d&&d.status==='ok'&&d.days&&typeof d.days==='object'&&Object.values(d.days).every(v=>Number.isInteger(v))){setGot({owner,branch,today,period,forState:state,days:d.days});setFailedFor(null);setUnavailFor(null);return;}
      fail();
    }catch{fail();}})();},bump?0:REFETCH_DEBOUNCE_MS);
    return()=>{clearTimeout(timer);ac.abort();};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[owner,branch,today,period,state,bump]);
  const unavailable=VISIT_TREND_ON&&unavailFor!==null&&unavailFor===state;
  return{days:state&&!unavailable?chooseVisitTrend(VISIT_TREND_ON,got,state,owner??'',branch,today,period):null,held:VISIT_TREND_ON&&!unavailable?heldVisitTrend(got,owner??'',branch,today,period):null,failed:VISIT_TREND_ON&&failedFor!==null&&failedFor===state,unavailable,retry};
}
