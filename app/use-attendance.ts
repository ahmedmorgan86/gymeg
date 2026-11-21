"use client";
// OFF (default): the Attendance page keeps its legacy expressions over the packet's visits. ON (NEXT_PUBLIC_GYMOS_ATTENDANCE=1): the branch's check-ins today and its newest 100 visits
// from the server, used only when fetched for THIS state object, owner, branch and day. Canonical branches: the server orders. Branches holding a non-canonical day/at: the server
// returns the canonical top 100 plus the non-canonical visits in position-ordered pages (`next` cursor, no row limit); THIS browser merges each page into a running top 100 with the page's own localeCompare comparator (exactly legacy). Memory stays at 100 + one page.
// Failure: `view` is null and `failed` is true. With NEXT_PUBLIC_GYMOS_LAZY_STRICT=1 (for when the packet omits visits) the page shows a retry state instead of the legacy expression,
// never a zero count or an empty table; otherwise the page keeps the legacy expression over the packet's visits.
import {useCallback,useEffect,useState} from 'react';
import type {GymState,Visit} from './lib/domain';
export const REFETCH_DEBOUNCE_MS=400; // collapses bursts of state changes into one read (judgment)
export const ATTENDANCE_ON=process.env.NEXT_PUBLIC_GYMOS_ATTENDANCE==='1';
export const LAZY_STRICT=process.env.NEXT_PUBLIC_GYMOS_LAZY_STRICT==='1';
export type AttendanceView={todayCount:number;rows:Visit[]};
type Got={owner:string;branch:string;day:string;forState:GymState;data:AttendanceView};
export function chooseAttendance(on:boolean,got:Got|null,state:GymState,owner:string,branch:string,day:string):AttendanceView|null{
  return on&&got&&got.owner===owner&&got.branch===branch&&got.day===day&&got.forState===state?got.data:null;
}
export type Cand={p:Visit;pos:number;id:string};
const posOrder=(a:Cand,b:Cand)=>a.pos-b.pos||(a.id<b.id?-1:a.id>b.id?1:0);
/** The page's own legacy comparator over candidates in position order (stable); null when a value is not a string (legacy would throw). Returns the newest n, kept in position order. */
export function mergeNewest(cands:Cand[],n:number):Cand[]|null{
  if(cands.some(k=>typeof k.p.day!=='string'||typeof k.p.at!=='string'))return null;
  const byPos=[...cands].sort(posOrder);
  const keep=new Set([...byPos].sort((a,b)=>b.p.day.localeCompare(a.p.day)||b.p.at.localeCompare(a.p.at)).slice(0,n));
  return byPos.filter(c=>keep.has(c));
}
/** Final order for display. */
export function pickNewest(cands:Cand[],n:number):Visit[]|null{
  const kept=mergeNewest(cands,n);return kept?[...kept].sort((a,b)=>b.p.day.localeCompare(a.p.day)||b.p.at.localeCompare(a.p.at)).map(c=>c.p):null;
}
export function useAttendance(active:boolean,state:GymState|undefined,owner:string|undefined,branch:string,day:string):{view:AttendanceView|null;failed:boolean;retry:()=>void}{
  const [got,setGot]=useState<Got|null>(null),[failedFor,setFailedFor]=useState<GymState|null>(null),[bump,setBump]=useState(0);
  const retry=useCallback(()=>setBump(n=>n+1),[]);
  useEffect(()=>{
    if(!ATTENDANCE_ON||!active||!owner||!state)return;const ac=new AbortController();
    const get=async(qs:string)=>{const r=await fetch('/api/workspace/attendance?branch='+encodeURIComponent(branch)+'&day='+encodeURIComponent(day)+qs,{headers:{'X-GymOS-Tenant':owner},signal:ac.signal,cache:'no-store'});return r.ok?await r.json() as {status?:string;todayCount?:number;rows?:Visit[];canonical?:Cand[];candidates?:Cand[];next?:{pos:number;id:string}|null;version?:string}:null;};
    const fail=()=>{if(!ac.signal.aborted){setGot(null);setFailedFor(state);}};
    const attemptRead=async(attempt:number):Promise<void>=>{try{
      const d=await get('');
      if(d&&d.status==='stale'){if(attempt<2)return void(await attemptRead(attempt+1));return fail();}
      if(d&&d.status==='ok'&&typeof d.todayCount==='number'&&Array.isArray(d.rows)){setGot({owner,branch,day,forState:state,data:{todayCount:d.todayCount,rows:d.rows}});setFailedFor(null);return;}
      if(d&&d.status==='irregular'&&typeof d.todayCount==='number'&&Array.isArray(d.canonical)&&Array.isArray(d.candidates)){
        let run=mergeNewest([...d.canonical,...d.candidates],100),next=d.next??null,stale=false;
        while(run&&next!==null){
          const pg=await get('&after='+next.pos+'&afterId='+encodeURIComponent(next.id)+'&ver='+encodeURIComponent(String(d.version)));
          if(pg&&pg.status==='stale'){stale=true;break;}
          if(!pg||pg.status!=='irregular'||!Array.isArray(pg.candidates)||pg.version!==d.version||pg.candidates.some(c=>posOrder({p:c.p,pos:c.pos,id:c.id},{p:c.p,pos:next!.pos,id:next!.id})<=0))return fail();
          run=mergeNewest([...run,...pg.candidates],100);next=pg.next??null;
        }
        if(stale){if(attempt<2)return void(await attemptRead(attempt+1));return fail();} // the owner changed between pages: restart from page 1 (bounded to 3 attempts), then the failure state
        if(run){setGot({owner,branch,day,forState:state,data:{todayCount:d.todayCount,rows:pickNewest(run,100)!}});setFailedFor(null);return;}
      }
      fail();
    }catch{fail();}};
    const timer=setTimeout(()=>{void attemptRead(0);},bump?0:REFETCH_DEBOUNCE_MS);
    return()=>{clearTimeout(timer);ac.abort();};
  },[active,owner,branch,day,state,bump]);
  return{view:state?chooseAttendance(ATTENDANCE_ON&&active,got,state,owner??'',branch,day):null,failed:ATTENDANCE_ON&&active&&failedFor!==null&&failedFor===state,retry};
}
