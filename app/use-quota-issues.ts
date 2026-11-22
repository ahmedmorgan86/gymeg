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
/** First load of a big backlog is `draining` for up to ceil(dirty/100) requests. The hook follows it with a BOUNDED, visible retry: at most DRAIN_MAX_ATTEMPTS fetches per state/key, spaced by an exponential backoff with jitter
 * (so staff browsers do not retry in lockstep against the owner lock) while the server reports progress (draining with recomputed>0) or `busy`; a draining answer with ZERO progress (another drainer took the rows) is allowed
 * DRAIN_ZERO_MAX times in a row, then it stops. The counters reset on an ok answer, on a new state object or key, and on Retry. */
export const DRAIN_MAX_ATTEMPTS=25,DRAIN_BASE_MS=1500,DRAIN_ZERO_MAX=3;
export function drainDelay(attempt:number,busy:boolean,rand:()=>number=Math.random):number{
  const base=busy?DRAIN_BASE_MS*Math.min(4,1.5**Math.max(0,attempt-1)):DRAIN_BASE_MS;return Math.round(base+rand()*Math.min(1500,base));
}
export function drainDecision(d:{status?:string;reason?:string;recomputed?:number}|null,attempt:number,zeroStreak=0):'retry'|'stop'{
  if(!d||d.status!=='fallback'||attempt>=DRAIN_MAX_ATTEMPTS)return 'stop';
  if(d.reason==='busy')return 'retry';
  if(d.reason==='draining'){const progressed=typeof d.recomputed==='number'&&d.recomputed>0;return progressed||zeroStreak<DRAIN_ZERO_MAX?'retry':'stop';}
  return 'stop';
}
export function useQuotaIssues(state:GymState,owner:string|undefined,branch:string,day:string,enabled=true):{quota:Set<string>|null;failed:boolean;retry:()=>void;progress:{attempt:number;max:number}|null}{
  const [got,setGot]=useState<Got|null>(null),[failedFor,setFailedFor]=useState<GymState|null>(null),[bump,setBump]=useState(0),[prog,setProg]=useState<{forState:GymState;attempt:number}|null>(null);
  const attempts=useRef<{key:string;state:GymState|null;n:number;zero:number}>({key:'',state:null,n:0,zero:0});
  const retry=useCallback(()=>{attempts.current={key:'',state:null,n:0,zero:0};setProg(null);setBump(n=>n+1);},[]);
  useEffect(()=>{
    if(!QUOTA_ISSUES_ON||!owner||!enabled)return;const ac=new AbortController();
    const key=owner+'|'+branch+'|'+day;if(attempts.current.key!==key||attempts.current.state!==state){attempts.current={key,state,n:0,zero:0};}
    let next:ReturnType<typeof setTimeout>|undefined;
    const timer=setTimeout(()=>{(async()=>{try{
      const r=await fetch('/api/workspace/quota-issues?branch='+encodeURIComponent(branch),{headers:{'X-GymOS-Tenant':owner},signal:ac.signal,cache:'no-store'});
      const d=r.ok?await r.json() as {status?:string;day?:string;quota?:unknown;reason?:string;recomputed?:number}:null;
      attempts.current.n++;if(d&&d.reason==='draining'){attempts.current.zero=typeof d.recomputed==='number'&&d.recomputed>0?0:attempts.current.zero+1;}
      // the server's day must be the client's day: a skewed clock is unknown, not a guess
      if(d&&d.status==='ok'&&d.day===day&&Array.isArray(d.quota)&&d.quota.every(x=>typeof x==='string')){setGot({owner,branch,day,forState:state,quota:new Set(d.quota as string[])});setFailedFor(null);setProg(null);attempts.current.n=0;attempts.current.zero=0;}else if(drainDecision(d,attempts.current.n,attempts.current.zero)==='retry'){setGot(null);setFailedFor(null);setProg({forState:state,attempt:attempts.current.n});next=setTimeout(()=>setBump(n=>n+1),drainDelay(attempts.current.n,d?.reason==='busy'));}else{setGot(null);setProg(null);setFailedFor(state);}
    }catch{if(!ac.signal.aborted){setGot(null);setFailedFor(state);}}})();},bump?0:REFETCH_DEBOUNCE_MS);
    return()=>{clearTimeout(timer);if(next)clearTimeout(next);ac.abort();};
  },[owner,branch,day,state,bump,enabled]);
  return{quota:enabled?chooseQuotaIssues(QUOTA_ISSUES_ON,got,state,owner??'',branch,day):null,failed:QUOTA_ISSUES_ON&&enabled&&failedFor!==null&&failedFor===state,retry,progress:QUOTA_ISSUES_ON&&enabled&&prog&&prog.forState===state?{attempt:prog.attempt,max:DRAIN_MAX_ATTEMPTS}:null};
}
