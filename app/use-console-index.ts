"use client";
// Console list source. OFF (default): exactly the legacy consoleIndex over the packet state. ON (NEXT_PUBLIC_GYMOS_MEMBER_SUMMARIES=1): the list is derived from the
// server's stored member candidates (version-checked, scoped by owner, branch and permission); until they arrive, or whenever anything is inexact, the legacy path runs.
import {useEffect,useMemo,useRef,useState} from 'react';
import type {GymState} from './lib/domain';
import {consoleIndex} from './lib/member-console';
import {CandidateCache,consoleIndexFromCandidates,type ConsoleCandidate} from './lib/member-console-candidates';
export const SUMMARIES_ON=process.env.NEXT_PUBLIC_GYMOS_MEMBER_SUMMARIES==='1';
type Row=ReturnType<typeof consoleIndex>[number];
export function useConsoleIndex(state:GymState,branch:string,owner:string,permission:string,financial:boolean,stamp:number):{rows:Row[];source:'legacy'|'candidates'}{
 const cache=useRef(new CandidateCache());
 const[cands,setCands]=useState<{owner:string;branch:string;scope:string;forState:GymState;list:ConsoleCandidate[]}|null>(null);
 const scope=permission+(financial?':fin':':nofin');
 useEffect(()=>{ // sign-out / tenant switch / permission change drops everything
  cache.current.clear();setCands(null);
 },[owner,scope]);
 useEffect(()=>{
  if(!SUMMARIES_ON)return;
  const ac=new AbortController();
  (async()=>{
   try{
    const since=cache.current.versionFor(owner,branch,scope);
    const r=await fetch('/api/workspace/member-candidates?branch='+encodeURIComponent(branch)+(since?'&since='+since:''),{headers:{'X-GymOS-Tenant':owner},signal:ac.signal,cache:'no-store'});
    if(!r.ok){setCands(null);return;}
    const d=await r.json() as {status:string;version?:string;candidates?:ConsoleCandidate[]};
    if(d.status==='ok'&&d.version&&d.candidates){cache.current.put(owner,branch,scope,d.version,d.candidates);setCands({owner,branch,scope,forState:state,list:d.candidates});}
    else if(d.status==='unchanged'&&d.version){const hit=cache.current.get(owner,branch,scope,d.version);setCands(hit?{owner,branch,scope,forState:state,list:hit}:null);}
    else setCands(null); // fallback: legacy list
   }catch{if(!ac.signal.aborted)setCands(null);}
  })();
  return()=>ac.abort();
 },[owner,branch,scope,state]); // state identity changes on every reload/mutation, so the version is re-checked cheaply
 return useMemo(()=>chooseRows(SUMMARIES_ON,cands,state,branch,owner,scope,stamp),[cands,state,branch,owner,scope,stamp]);
}
/** Pure row choice (unit-tested): candidates are used only when they were fetched for THIS state object, owner, branch and permission scope. */
export function chooseRows(on:boolean,cands:{owner:string;branch:string;scope:string;forState:GymState;list:ConsoleCandidate[]}|null,state:GymState,branch:string,owner:string,scope:string,stamp:number):{rows:Row[];source:'legacy'|'candidates'}{
  const now=new Date(stamp).toISOString();
  if(on&&cands&&cands.owner===owner&&cands.branch===branch&&cands.scope===scope&&cands.forState===state){
   const r=consoleIndexFromCandidates(cands.list,{settings:state.settings,plans:state.plans},branch,now);
   if(r.status==='ok')return{rows:r.rows as unknown as Row[],source:'candidates'};
  }
  return{rows:consoleIndex(state,branch,now),source:'legacy'};
}
