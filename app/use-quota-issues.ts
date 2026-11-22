"use client";
// OFF (default): the Overview keeps membershipIssue() over the packet's visits. ON (NEXT_PUBLIC_GYMOS_QUOTA_ISSUES=1): the ids of the branch's members with a quota issue today, from the server clock.
// Used only when fetched for THIS state object, owner, branch and day (a failed refetch drops the hold); null otherwise. Issue classification only, never numeric used/visitsRemaining.
import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {REFETCH_DEBOUNCE_MS,LAZY_STRICT} from './use-attendance';
import type {GymState} from './lib/domain';
import {quotaSignature} from './lib/quota-compose';
export const QUOTA_ISSUES_ON=process.env.NEXT_PUBLIC_GYMOS_QUOTA_ISSUES==='1';
type Got={owner:string;branch:string;day:string;forState:string;quota:Set<string>};
export function chooseQuotaIssues(on:boolean,got:Got|null,state:string,owner:string,branch:string,day:string):Set<string>|null{
  return on&&got&&got.owner===owner&&got.branch===branch&&got.day===day&&got.forState===state?got.quota:null;
}
export {LAZY_STRICT};
/** First load of a big backlog is `draining` for up to ceil(dirty/100) requests. The hook follows it with a BOUNDED, visible retry: at most DRAIN_MAX_ATTEMPTS fetches per state/key, spaced by an exponential backoff with jitter
 * (so staff browsers do not retry in lockstep against the owner lock) while the server reports progress (draining with recomputed>0) or `busy`; a draining answer with ZERO progress (another drainer took the rows) is allowed
 * DRAIN_ZERO_MAX times in a row, then it stops. The counters reset on an ok answer, on a new state object or key, and on Retry. */
/** A continuous stream of writes (every state/revision change restarts the debounce) must not starve the read: a pending change waits at most QUOTA_MAX_WAIT_MS. */
export const QUOTA_MAX_WAIT_MS=2000;
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
export function useQuotaIssues(stateObj:GymState,owner:string|undefined,branch:string,day:string,enabled=true,revision?:number|string|null):{quota:Set<string>|null;failed:boolean;retry:()=>void;progress:{attempt:number;max:number}|null}{
  // identity of the packet object changes on every sync/poll/no-op; the hold is keyed by the quota-relevant content, so an idle poll neither drops it nor refetches
  const state=useMemo(()=>enabled&&QUOTA_ISSUES_ON?quotaSignature(stateObj,branch,revision):'',[stateObj,branch,enabled,revision]);
  const [got,setGot]=useState<Got|null>(null),[failedFor,setFailedFor]=useState<string|null>(null),[bump,setBump]=useState(0),[prog,setProg]=useState<{forState:string;attempt:number}|null>(null);
  const pendingSince=useRef<number|null>(null);
  // single flight: at most ONE read in flight per client; a change while it runs is never an abort, it queues exactly one follow-up that runs after the read settles (a stale-signature answer is discarded, not applied)
  const inflight=useRef(false),queued=useRef(false),sigRef=useRef(state),acRef=useRef<AbortController|null>(null);
  useEffect(()=>{sigRef.current=state;},[state]);
  useEffect(()=>()=>{acRef.current?.abort();},[owner,branch,day,enabled]);
  const attempts=useRef<{key:string;state:string|null;n:number;zero:number}>({key:'',state:null,n:0,zero:0});
  const retry=useCallback(()=>{attempts.current={key:'',state:null,n:0,zero:0};setProg(null);setBump(n=>n+1);},[]);
  useEffect(()=>{
    if(!QUOTA_ISSUES_ON||!owner||!enabled)return;const ac=new AbortController();
    const key=owner+'|'+branch+'|'+day;if(attempts.current.key!==key||attempts.current.state!==state){attempts.current={key,state,n:0,zero:0};}
    let next:ReturnType<typeof setTimeout>|undefined;
    const now=Date.now();if(pendingSince.current===null)pendingSince.current=now;const wait=bump?0:Math.max(0,Math.min(REFETCH_DEBOUNCE_MS,pendingSince.current+QUOTA_MAX_WAIT_MS-now));
    const timer=setTimeout(()=>{pendingSince.current=null;if(inflight.current){queued.current=true;return;}inflight.current=true;acRef.current=ac;(async()=>{try{
      const r=await fetch('/api/workspace/quota-issues?branch='+encodeURIComponent(branch),{headers:{'X-GymOS-Tenant':owner},signal:ac.signal,cache:'no-store'});
      const d=r.ok?await r.json() as {status?:string;day?:string;quota?:unknown;reason?:string;recomputed?:number}:null;
      if(sigRef.current!==state)return; // superseded while in flight: discard, the queued follow-up reads the current state
      attempts.current.n++;if(d&&d.reason==='draining'){attempts.current.zero=typeof d.recomputed==='number'&&d.recomputed>0?0:attempts.current.zero+1;}
      // the server's day must be the client's day: a skewed clock is unknown, not a guess
      if(d&&d.status==='ok'&&d.day===day&&Array.isArray(d.quota)&&d.quota.every(x=>typeof x==='string')){setGot({owner,branch,day,forState:state,quota:new Set(d.quota as string[])});setFailedFor(null);setProg(null);attempts.current.n=0;attempts.current.zero=0;}else if(drainDecision(d,attempts.current.n,attempts.current.zero)==='retry'){setGot(null);setFailedFor(null);setProg({forState:state,attempt:attempts.current.n});next=setTimeout(()=>setBump(n=>n+1),drainDelay(attempts.current.n,d?.reason==='busy'));}else{setGot(null);setProg(null);setFailedFor(state);}
    }catch{if(!ac.signal.aborted&&sigRef.current===state){setGot(null);setFailedFor(state);}}finally{inflight.current=false;if(queued.current||sigRef.current!==state){queued.current=false;setBump(n=>n+1);}}})();},wait);
    return()=>{clearTimeout(timer);if(next)clearTimeout(next);};
  },[owner,branch,day,state,bump,enabled]);
  return{quota:enabled?chooseQuotaIssues(QUOTA_ISSUES_ON,got,state,owner??'',branch,day):null,failed:QUOTA_ISSUES_ON&&enabled&&failedFor!==null&&failedFor===state,retry,progress:QUOTA_ISSUES_ON&&enabled&&prog&&prog.forState===state?{attempt:prog.attempt,max:DRAIN_MAX_ATTEMPTS}:null};
}
