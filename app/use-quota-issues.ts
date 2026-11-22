"use client";
// OFF (default): the Overview keeps membershipIssue() over the packet's visits. ON (NEXT_PUBLIC_GYMOS_QUOTA_ISSUES=1): the ids of the branch's members with a quota issue today, from the server clock.
// Used only when fetched for THIS state object, owner, branch and day (a failed refetch drops the hold); null otherwise. Issue classification only, never numeric used/visitsRemaining.
import {useCallback,useEffect,useState} from 'react';
import {REFETCH_DEBOUNCE_MS,LAZY_STRICT} from './use-attendance';
import type {GymState} from './lib/domain';
export const QUOTA_ISSUES_ON=process.env.NEXT_PUBLIC_GYMOS_QUOTA_ISSUES==='1';
type Got={owner:string;branch:string;day:string;forState:GymState;quota:Set<string>};
export function chooseQuotaIssues(on:boolean,got:Got|null,state:GymState,owner:string,branch:string,day:string):Set<string>|null{
  return on&&got&&got.owner===owner&&got.branch===branch&&got.day===day&&got.forState===state?got.quota:null;
}
export {LAZY_STRICT};
export function useQuotaIssues(state:GymState,owner:string|undefined,branch:string,day:string,enabled=true):{quota:Set<string>|null;failed:boolean;retry:()=>void}{
  const [got,setGot]=useState<Got|null>(null),[failedFor,setFailedFor]=useState<GymState|null>(null),[bump,setBump]=useState(0);
  const retry=useCallback(()=>setBump(n=>n+1),[]);
  useEffect(()=>{
    if(!QUOTA_ISSUES_ON||!owner||!enabled)return;const ac=new AbortController();
    const timer=setTimeout(()=>{(async()=>{try{
      const r=await fetch('/api/workspace/quota-issues?branch='+encodeURIComponent(branch),{headers:{'X-GymOS-Tenant':owner},signal:ac.signal,cache:'no-store'});
      const d=r.ok?await r.json() as {status?:string;day?:string;quota?:unknown}:null;
      // the server's day must be the client's day: a skewed clock is unknown, not a guess
      if(d&&d.status==='ok'&&d.day===day&&Array.isArray(d.quota)&&d.quota.every(x=>typeof x==='string')){setGot({owner,branch,day,forState:state,quota:new Set(d.quota as string[])});setFailedFor(null);}else{setGot(null);setFailedFor(state);}
    }catch{if(!ac.signal.aborted){setGot(null);setFailedFor(state);}}})();},bump?0:REFETCH_DEBOUNCE_MS);
    return()=>{clearTimeout(timer);ac.abort();};
  },[owner,branch,day,state,bump,enabled]);
  return{quota:enabled?chooseQuotaIssues(QUOTA_ISSUES_ON,got,state,owner??'',branch,day):null,failed:QUOTA_ISSUES_ON&&enabled&&failedFor!==null&&failedFor===state,retry};
}
