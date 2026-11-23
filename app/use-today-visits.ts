"use client";
// OFF (default): callers keep their legacy packet expressions. ON (NEXT_PUBLIC_GYMOS_TODAY_VISITS=1): count and latest visits of one branch-day from the server,
// used only when fetched for THIS state object, owner, branch and day; null otherwise (caller uses the legacy expression).
import {useCallback,useEffect,useState} from 'react';
import {LAZY_STRICT} from './use-attendance';
import type {GymState} from './lib/domain';
export const REFETCH_DEBOUNCE_MS=400; // collapses bursts of state changes into one read (judgment)
export const TODAY_ON=process.env.NEXT_PUBLIC_GYMOS_TODAY_VISITS==='1';
export type TodayData={count:number;latest:{id:string;member:string;at:string;activeAt?:string;name:string|null}[]};
type Got={owner:string;branch:string;day:string;forState:GymState;data:TodayData};
export function chooseToday(on:boolean,got:Got|null,state:GymState,owner:string,branch:string,day:string):TodayData|null{
  return on&&got&&got.owner===owner&&got.branch===branch&&got.day===day&&got.forState===state?got.data:null;
}
export {LAZY_STRICT};
/** `failed`: the last read for this state failed. With NEXT_PUBLIC_GYMOS_LAZY_STRICT=1 callers show a retry state instead of the legacy expression (for when the packet omits visits). */
export function useTodayVisits(state:GymState,owner:string|undefined,branch:string,day:string):{data:TodayData|null;failed:boolean;retry:()=>void}{
  const [got,setGot]=useState<Got|null>(null),[failedFor,setFailedFor]=useState<GymState|null>(null),[bump,setBump]=useState(0);
  const retry=useCallback(()=>setBump(n=>n+1),[]);
  useEffect(()=>{
    if(!TODAY_ON||!owner)return;const ac=new AbortController();
    const timer=setTimeout(()=>{(async()=>{try{
      const r=await fetch('/api/workspace/today-visits?branch='+encodeURIComponent(branch)+'&day='+encodeURIComponent(day),{headers:{'X-GymOS-Tenant':owner},signal:ac.signal,cache:'no-store'});
      const d=r.ok?await r.json() as {status?:string}&Partial<TodayData>:null;
      if(d&&d.status==='ok'&&typeof d.count==='number'&&d.latest){setGot({owner,branch,day,forState:state,data:{count:d.count,latest:d.latest}});setFailedFor(null);}else{setGot(null);setFailedFor(state);}
    }catch{if(!ac.signal.aborted){setGot(null);setFailedFor(state);}}})();},bump?0:REFETCH_DEBOUNCE_MS);
    return()=>{clearTimeout(timer);ac.abort();};
  },[owner,branch,day,state,bump]);
  return{data:chooseToday(TODAY_ON,got,state,owner??'',branch,day),failed:TODAY_ON&&failedFor!==null&&failedFor===state,retry};
}
