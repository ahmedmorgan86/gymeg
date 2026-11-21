"use client";
// OFF (default): the Attendance page keeps its legacy expressions over the packet's visits. ON (NEXT_PUBLIC_GYMOS_ATTENDANCE=1): the branch's check-ins today and its newest 100 visits
// from the server, used only when fetched for THIS state object, owner, branch and day; null otherwise (legacy). `active` keeps other pages from fetching.
import {useEffect,useState} from 'react';
import type {GymState,Visit} from './lib/domain';
export const REFETCH_DEBOUNCE_MS=400; // collapses bursts of state changes into one read (judgment)
export const ATTENDANCE_ON=process.env.NEXT_PUBLIC_GYMOS_ATTENDANCE==='1';
export type AttendanceView={todayCount:number;rows:Visit[]};
type Got={owner:string;branch:string;day:string;forState:GymState;data:AttendanceView};
export function chooseAttendance(on:boolean,got:Got|null,state:GymState,owner:string,branch:string,day:string):AttendanceView|null{
  return on&&got&&got.owner===owner&&got.branch===branch&&got.day===day&&got.forState===state?got.data:null;
}
export function useAttendance(active:boolean,state:GymState|undefined,owner:string|undefined,branch:string,day:string):AttendanceView|null{
  const [got,setGot]=useState<Got|null>(null);
  useEffect(()=>{
    if(!ATTENDANCE_ON||!active||!owner||!state)return;const ac=new AbortController();
    const timer=setTimeout(()=>{(async()=>{try{
      const r=await fetch('/api/workspace/attendance?branch='+encodeURIComponent(branch)+'&day='+encodeURIComponent(day),{headers:{'X-GymOS-Tenant':owner},signal:ac.signal,cache:'no-store'});
      const d=r.ok?await r.json() as {status?:string;todayCount?:number;rows?:Visit[]}:null;
      if(d&&d.status==='ok'&&typeof d.todayCount==='number'&&Array.isArray(d.rows))setGot({owner,branch,day,forState:state,data:{todayCount:d.todayCount,rows:d.rows}});else setGot(null);
    }catch{if(!ac.signal.aborted)setGot(null);}})();},REFETCH_DEBOUNCE_MS);
    return()=>{clearTimeout(timer);ac.abort();};
  },[active,owner,branch,day,state]);
  return state?chooseAttendance(ATTENDANCE_ON&&active,got,state,owner??'',branch,day):null;
}
