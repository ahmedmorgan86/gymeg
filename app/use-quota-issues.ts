"use client";
// OFF (default): the Overview keeps membershipIssue() over the packet's visits. ON (NEXT_PUBLIC_GYMOS_QUOTA_ISSUES=1): the ids of the branch's members with a quota issue today, from the server clock.
// Used only when fetched for THIS state object, owner, branch and day (a failed refetch drops the hold); null otherwise. Issue classification only, never numeric used/visitsRemaining.
import {useCallback,useEffect,useRef,useState} from 'react';
import {REFETCH_DEBOUNCE_MS,LAZY_STRICT} from './use-attendance';
import type {GymState} from './lib/domain';
export const QUOTA_ISSUES_ON=process.env.NEXT_PUBLIC_GYMOS_QUOTA_ISSUES==='1';
type Got={owner:string;branch:string;day:string;forState:GymState;quota:Set<string>};
export function chooseQuotaIssues(on:boolean,got:Got|null,state:GymState,owner:string,branch:string,day:string):Set<string>|null{
  return on&&got&&got.owner===owner&&got.branch===branch&&got.day===day&&got.forState===state?got.quota:null;
}
export {LAZY_STRICT};
/** First load of a big backlog is `draining` for up to ceil(dirty/100) requests. The hook follows it with a BOUNDED, visible retry: at most DRAIN_MAX_ATTEMPTS attempts spaced DRAIN_DELAY_MS apart, only while the server reports progress
 * (draining with recomputed>0) or `busy` (another wave holds the owner lock). Then it stops and shows Retry. The counter resets only when the state/owner/branch/day key changes or the user presses Retry. */
export const DRAIN_MAX_ATTEMPTS=25,DRAIN_DELAY_MS=1500;
export function drainDecision(d:{status?:string;reason?:string;recomputed?:number}|null,attempt:number):'retry'|'stop'{
  if(!d||d.status!=='fallback')return 'stop';
  const progressing=d.reason==='draining'&&typeof d.recomputed==='number'&&d.recomputed>0,busy=d.reason==='busy';
  return (progressing||busy)&&attempt<DRAIN_MAX_ATTEMPTS?'retry':'stop';
}
export function useQuotaIssues(state:GymState,owner:string|undefined,branch:string,day:string,enabled=true):{quota:Set<string>|null;failed:boolean;retry:()=>void;progress:{attempt:number;max:number}|null}{
  const [got,setGot]=useState<Got|null>(null),[failedFor,setFailedFor]=useState<GymState|null>(null),[bump,setBump]=useState(0),[prog,setProg]=useState<{forState:GymState;attempt:number}|null>(null);
  const attempts=useRef({key:'',n:0});
  const retry=useCallback(()=>{attempts.current.n=0;setProg(null);setBump(n=>n+1);},[]);
  useEffect(()=>{
    if(!QUOTA_ISSUES_ON||!owner||!enabled)return;const ac=new AbortController();
    const key=owner+'|'+branch+'|'+day;if(attempts.current.key!==key){attempts.current={key,n:0};}
    let next:ReturnType<typeof setTimeout>|undefined;
    const timer=setTimeout(()=>{(async()=>{try{
      const r=await fetch('/api/workspace/quota-issues?branch='+encodeURIComponent(branch),{headers:{'X-GymOS-Tenant':owner},signal:ac.signal,cache:'no-store'});
      const d=r.ok?await r.json() as {status?:string;day?:string;quota?:unknown;reason?:string;recomputed?:number}:null;
      attempts.current.n++;
      // the server's day must be the client's day: a skewed clock is unknown, not a guess
      if(d&&d.status==='ok'&&d.day===day&&Array.isArray(d.quota)&&d.quota.every(x=>typeof x==='string')){setGot({owner,branch,day,forState:state,quota:new Set(d.quota as string[])});setFailedFor(null);setProg(null);}else if(drainDecision(d,attempts.current.n)==='retry'){setGot(null);setFailedFor(null);setProg({forState:state,attempt:attempts.current.n});next=setTimeout(()=>setBump(n=>n+1),DRAIN_DELAY_MS);}else{setGot(null);setProg(null);setFailedFor(state);}
    }catch{if(!ac.signal.aborted){setGot(null);setFailedFor(state);}}})();},bump?0:REFETCH_DEBOUNCE_MS);
    return()=>{clearTimeout(timer);if(next)clearTimeout(next);ac.abort();};
  },[owner,branch,day,state,bump,enabled]);
  return{quota:enabled?chooseQuotaIssues(QUOTA_ISSUES_ON,got,state,owner??'',branch,day):null,failed:QUOTA_ISSUES_ON&&enabled&&failedFor!==null&&failedFor===state,retry,progress:QUOTA_ISSUES_ON&&enabled&&prog&&prog.forState===state?{attempt:prog.attempt,max:DRAIN_MAX_ATTEMPTS}:null};
}
