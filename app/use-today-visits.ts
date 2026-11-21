"use client";
// OFF (default): callers keep their legacy packet expressions. ON (NEXT_PUBLIC_GYMOS_TODAY_VISITS=1): count and latest visits of one branch-day from the server,
// used only when fetched for THIS state object, owner, branch and day; null otherwise (caller uses the legacy expression).
import {useEffect,useState} from 'react';
import type {GymState} from './lib/domain';
export const TODAY_ON=process.env.NEXT_PUBLIC_GYMOS_TODAY_VISITS==='1';
export type TodayData={count:number;latest:{id:string;member:string;at:string;activeAt?:string;name:string|null}[]};
type Got={owner:string;branch:string;day:string;forState:GymState;data:TodayData};
export function chooseToday(on:boolean,got:Got|null,state:GymState,owner:string,branch:string,day:string):TodayData|null{
  return on&&got&&got.owner===owner&&got.branch===branch&&got.day===day&&got.forState===state?got.data:null;
}
export function useTodayVisits(state:GymState,owner:string|undefined,branch:string,day:string):TodayData|null{
  const [got,setGot]=useState<Got|null>(null);
  useEffect(()=>{
    if(!TODAY_ON||!owner)return;const ac=new AbortController();
    (async()=>{try{
      const r=await fetch('/api/workspace/today-visits?branch='+encodeURIComponent(branch)+'&day='+encodeURIComponent(day),{headers:{'X-GymOS-Tenant':owner},signal:ac.signal,cache:'no-store'});
      const d=r.ok?await r.json() as {status?:string}&Partial<TodayData>:null;
      if(d&&d.status==='ok'&&typeof d.count==='number'&&d.latest)setGot({owner,branch,day,forState:state,data:{count:d.count,latest:d.latest}});else setGot(null);
    }catch{if(!ac.signal.aborted)setGot(null);}})();
    return()=>ac.abort();
  },[owner,branch,day,state]);
  return chooseToday(TODAY_ON,got,state,owner??'',branch,day);
}
