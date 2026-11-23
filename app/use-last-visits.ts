"use client";
// OFF (default): manualWhatsAppDue keeps scanning the packet's visits. ON (NEXT_PUBLIC_GYMOS_LAST_VISITS=1): latest visit day <= today per member of the branch from the server,
// used only when fetched for THIS state object, owner, branch and day; null otherwise (caller keeps the packet expression).
import {useCallback,useEffect,useState} from 'react';
import {REFETCH_DEBOUNCE_MS,LAZY_STRICT} from './use-attendance';
import type {GymState} from './lib/domain';
export const LAST_VISITS_ON=process.env.NEXT_PUBLIC_GYMOS_LAST_VISITS==='1';
type Got={owner:string;branch:string;today:string;forState:GymState;last:Map<string,string>};
export function chooseLastVisits(on:boolean,got:Got|null,state:GymState,owner:string,branch:string,today:string):Map<string,string>|null{
  return on&&got&&got.owner===owner&&got.branch===branch&&got.today===today&&got.forState===state?got.last:null;
}
export {LAZY_STRICT};
/** `failed`: the last read for this state failed or was unavailable. Callers show a visible retry notice (and with LAZY_STRICT stop using the packet expression). */
export function useLastVisits(state:GymState,owner:string|undefined,branch:string,today:string,enabled=true):{last:Map<string,string>|null;failed:boolean;retry:()=>void}{
  const [got,setGot]=useState<Got|null>(null),[failedFor,setFailedFor]=useState<GymState|null>(null),[bump,setBump]=useState(0);
  const retry=useCallback(()=>setBump(n=>n+1),[]);
  useEffect(()=>{
    if(!LAST_VISITS_ON||!owner||!enabled)return;const ac=new AbortController();
    const timer=setTimeout(()=>{(async()=>{try{
      const r=await fetch('/api/workspace/last-visits?branch='+encodeURIComponent(branch)+'&today='+today,{headers:{'X-GymOS-Tenant':owner},signal:ac.signal,cache:'no-store'});
      const d=r.ok?await r.json() as {status?:string;last?:Record<string,string>}:null;
      if(d&&d.status==='ok'&&d.last&&typeof d.last==='object'){setGot({owner,branch,today,forState:state,last:new Map(Object.entries(d.last))});setFailedFor(null);}else{setGot(null);setFailedFor(state);}
    }catch{if(!ac.signal.aborted){setGot(null);setFailedFor(state);}}})();},bump?0:REFETCH_DEBOUNCE_MS);
    return()=>{clearTimeout(timer);ac.abort();};
  },[owner,branch,today,state,bump,enabled]);
  return{last:enabled?chooseLastVisits(LAST_VISITS_ON,got,state,owner??'',branch,today):null,failed:LAST_VISITS_ON&&enabled&&failedFor!==null&&failedFor===state,retry};
}
