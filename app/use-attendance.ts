"use client";
// OFF (default): the Attendance page keeps its legacy expressions over the packet's visits. ON (NEXT_PUBLIC_GYMOS_ATTENDANCE=1): the branch's check-ins today and its newest 100 visits
// from the server, used only when fetched for THIS state object, owner, branch and day. Canonical branches: the server orders. Branches holding a non-canonical day/at: the server
// returns (id,day,at) in position order, THIS browser sorts them with the page's own localeCompare comparator (exactly legacy), and the 100 chosen rows are fetched by id.
// Failure: `view` is null and `failed` is true. With NEXT_PUBLIC_GYMOS_LAZY_STRICT=1 (for when the packet omits visits) the page shows a retry state instead of the legacy expression,
// never a zero count or an empty table; otherwise the page keeps the legacy expression over the packet's visits.
import {useCallback,useEffect,useState} from 'react';
import type {GymState,Visit} from './lib/domain';
export const REFETCH_DEBOUNCE_MS=400; // collapses bursts of state changes into one read (judgment)
export const ATTENDANCE_ON=process.env.NEXT_PUBLIC_GYMOS_ATTENDANCE==='1';
export const LAZY_STRICT=process.env.NEXT_PUBLIC_GYMOS_LAZY_STRICT==='1';
export type AttendanceView={todayCount:number;rows:Visit[]};
type Got={owner:string;branch:string;day:string;forState:GymState;data:AttendanceView};
type Key={id:string;day:unknown;at:unknown};
export function chooseAttendance(on:boolean,got:Got|null,state:GymState,owner:string,branch:string,day:string):AttendanceView|null{
  return on&&got&&got.owner===owner&&got.branch===branch&&got.day===day&&got.forState===state?got.data:null;
}
/** The page's own legacy comparator over the server's keys (position order in, stable sort); null when a value is not a string (legacy would throw). */
export function pickNewest(keys:Key[],n:number):string[]|null{
  if(keys.some(k=>typeof k.day!=='string'||typeof k.at!=='string'))return null;
  return [...keys].sort((a,b)=>(b.day as string).localeCompare(a.day as string)||(b.at as string).localeCompare(a.at as string)).slice(0,n).map(k=>k.id);
}
export function useAttendance(active:boolean,state:GymState|undefined,owner:string|undefined,branch:string,day:string):{view:AttendanceView|null;failed:boolean;retry:()=>void}{
  const [got,setGot]=useState<Got|null>(null),[failedFor,setFailedFor]=useState<GymState|null>(null),[bump,setBump]=useState(0);
  const retry=useCallback(()=>setBump(n=>n+1),[]);
  useEffect(()=>{
    if(!ATTENDANCE_ON||!active||!owner||!state)return;const ac=new AbortController();
    const get=async(qs:string)=>{const r=await fetch('/api/workspace/attendance?branch='+encodeURIComponent(branch)+'&day='+encodeURIComponent(day)+qs,{headers:{'X-GymOS-Tenant':owner},signal:ac.signal,cache:'no-store'});return r.ok?await r.json() as {status?:string;todayCount?:number;rows?:Visit[];keys?:Key[]}:null;};
    const fail=()=>{if(!ac.signal.aborted){setGot(null);setFailedFor(state);}};
    const timer=setTimeout(()=>{(async()=>{try{
      const d=await get('');
      if(d&&d.status==='ok'&&typeof d.todayCount==='number'&&Array.isArray(d.rows)){setGot({owner,branch,day,forState:state,data:{todayCount:d.todayCount,rows:d.rows}});setFailedFor(null);return;}
      if(d&&d.status==='irregular'&&typeof d.todayCount==='number'&&Array.isArray(d.keys)){
        const ids=pickNewest(d.keys,100);if(!ids)return fail();
        const rows=ids.length?await get('&ids='+encodeURIComponent(ids.join(','))):{status:'ok',rows:[]};
        if(rows&&rows.status==='ok'&&Array.isArray(rows.rows)&&rows.rows.length===ids.length){setGot({owner,branch,day,forState:state,data:{todayCount:d.todayCount,rows:rows.rows}});setFailedFor(null);return;}
      }
      fail();
    }catch{fail();}})();},bump?0:REFETCH_DEBOUNCE_MS);
    return()=>{clearTimeout(timer);ac.abort();};
  },[active,owner,branch,day,state,bump]);
  return{view:state?chooseAttendance(ATTENDANCE_ON&&active,got,state,owner??'',branch,day):null,failed:ATTENDANCE_ON&&active&&failedFor!==null&&failedFor===state,retry};
}
