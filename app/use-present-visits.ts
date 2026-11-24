"use client";
import {useCallback,useEffect,useState} from 'react';
import {LAZY_STRICT,REFETCH_DEBOUNCE_MS} from './use-attendance';
import type {GymState} from './lib/domain';
export const PRESENT_ON=process.env.NEXT_PUBLIC_GYMOS_PRESENT_VISITS==='1';
export {LAZY_STRICT};
type Got={state:GymState;owner:string;branch:string;rows:GymState['visits']};
export function choosePresent(on:boolean,got:Got|null,state:GymState,owner:string,branch:string){return on&&got&&got.state===state&&got.owner===owner&&got.branch===branch?got.rows:null;}
export function usePresentVisits(state:GymState,owner:string,branch:string){
 const [got,setGot]=useState<Got|null>(null),[failed,setFailed]=useState<GymState|null>(null),[bump,setBump]=useState(0),[tick,setTick]=useState(0);const retry=useCallback(()=>setBump(x=>x+1),[]);
 useEffect(()=>{if(!PRESENT_ON)return;const timer=setInterval(()=>setTick(x=>x+1),60000);return()=>clearInterval(timer)},[]);
 useEffect(()=>{if(!PRESENT_ON||!owner)return;const ac=new AbortController();const timer=setTimeout(()=>{void(async()=>{try{const r=await fetch('/api/workspace/present-visits?branch='+encodeURIComponent(branch),{headers:{'X-GymOS-Tenant':owner},cache:'no-store',signal:ac.signal});const d=r.ok?await r.json():null;if(ac.signal.aborted)return;if(d?.status==='ok'&&Array.isArray(d.present)){setGot({state,owner,branch,rows:d.present});setFailed(null)}else{setGot(null);setFailed(state)}}catch{if(!ac.signal.aborted){setGot(null);setFailed(state)}}})();},bump?0:REFETCH_DEBOUNCE_MS);return()=>{clearTimeout(timer);ac.abort()}},[state,owner,branch,bump,tick]);
 return{rows:choosePresent(PRESENT_ON,got,state,owner,branch),failed:PRESENT_ON&&failed===state,retry};
}
