"use client";
// OFF (default): the Operations dues tab keeps its legacy expressions over the packet's invoices. ON (NEXT_PUBLIC_GYMOS_DUES=1): headline total plus keyset pages of invoice rows
// from the server, used only when fetched for THIS state object, owner, branch and member filter. Pages carry the owner version of page 1; a stale page restarts from page 1
// (3 attempts, then the failure state). More rows are offered by `loadMore`, never silently dropped. With NEXT_PUBLIC_GYMOS_LAZY_STRICT=1 failure shows Retry instead of the legacy expression.
import {useCallback,useEffect,useRef,useState} from 'react';
import type {GymState} from './lib/domain';
import {REFETCH_DEBOUNCE_MS} from './use-attendance';
export const DUES_ON=process.env.NEXT_PUBLIC_GYMOS_DUES==='1';
export type DueRow={invoice:{id:string;member:string;title:string;total:number;due:string;branch:string;voided:boolean;allocations:{payment:string;minor:number}[]};outstanding:number;name:string|null;allocations:{payment:string;found:boolean;day:string|null;method:string|null;voided:boolean|null}[]};
type Cur={pos:number;id:string};
export type DuesView={total:number;rows:DueRow[];hasMore:boolean};
type Got={owner:string;branch:string;member:string;forState:GymState;data:{total:number;rows:DueRow[];version:string;next:Cur|null}};
export function chooseDues(on:boolean,got:Got|null,state:GymState,owner:string,branch:string,member:string):DuesView|null{
  return on&&got&&got.owner===owner&&got.branch===branch&&got.member===member&&got.forState===state?{total:got.data.total,rows:got.data.rows,hasMore:got.data.next!==null}:null;
}
export function useDues(active:boolean,state:GymState|undefined,owner:string|undefined,branch:string,member:string):{view:DuesView|null;failed:boolean;retry:()=>void;loadMore:()=>void;loadingMore:boolean}{
  const [got,setGot]=useState<Got|null>(null),[failedFor,setFailedFor]=useState<GymState|null>(null),[bump,setBump]=useState(0),[loadingMore,setLoadingMore]=useState(false);
  const gotRef=useRef<Got|null>(null);gotRef.current=got;
  const retry=useCallback(()=>setBump(n=>n+1),[]);
  const q=(extra:string)=>'/api/workspace/dues?branch='+encodeURIComponent(branch)+(member?'&member='+encodeURIComponent(member):'')+extra;
  const loadMore=useCallback(()=>{
    const g=gotRef.current;if(!g||!g.data.next||!owner||!state||g.forState!==state)return;setLoadingMore(true);
    (async()=>{try{
      const r=await fetch(q('&after='+g.data.next!.pos+'&afterId='+encodeURIComponent(g.data.next!.id)+'&ver='+encodeURIComponent(g.data.version)),{headers:{'X-GymOS-Tenant':owner},cache:'no-store'});
      const d=r.ok?await r.json() as {status?:string;version?:string;rows?:DueRow[];next?:Cur|null}:null;
      if(d&&d.status==='irregular')return;
      if(d&&d.status==='ok'&&d.version===g.data.version&&Array.isArray(d.rows)){setGot({...g,data:{...g.data,rows:[...g.data.rows,...d.rows],next:d.next??null}});}
      else setBump(n=>n+1); // stale or failed: restart from page 1 (the effect shows the failure state if it fails again)
    }catch{setBump(n=>n+1);}finally{setLoadingMore(false);}})();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[owner,state,branch,member]);
  useEffect(()=>{
    if(!DUES_ON||!active||!owner||!state)return;const ac=new AbortController();
    const fail=()=>{if(!ac.signal.aborted){setGot(null);setFailedFor(state);}};
    const timer=setTimeout(()=>{(async()=>{try{
      const r=await fetch(q(''),{headers:{'X-GymOS-Tenant':owner},signal:ac.signal,cache:'no-store'});
      const d=r.ok?await r.json() as {status?:string;version?:string;total?:number;rows?:DueRow[];next?:Cur|null}:null;
      if(d&&d.status==='ok'&&typeof d.total==='number'&&typeof d.version==='string'&&Array.isArray(d.rows)){setGot({owner,branch,member,forState:state,data:{total:d.total,rows:d.rows,version:d.version,next:d.next??null}});setFailedFor(null);return;}
      fail();
    }catch{fail();}})();},bump?0:REFETCH_DEBOUNCE_MS);
    return()=>{clearTimeout(timer);ac.abort();};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[active,owner,branch,member,state,bump]);
  return{view:state?chooseDues(DUES_ON&&active,got,state,owner??'',branch,member):null,failed:DUES_ON&&active&&failedFor!==null&&failedFor===state,retry,loadMore,loadingMore};
}
