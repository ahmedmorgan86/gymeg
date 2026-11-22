"use client";
// OFF (default): the Reports page builds payment rows from the packet (paymentBreakdown over every invoice). ON (NEXT_PUBLIC_GYMOS_REPORT_PAYMENTS=1): the branch's payments of the chosen day range
// (with breakdown and member name) are pulled in keyset pages at one owner version (a stale page restarts, 3 attempts), used only for THIS state object, owner, branch and range.
// The page keeps its own filter, search, totals, paging and ordering over these rows. A failure shows a visible Retry; with NEXT_PUBLIC_GYMOS_LAZY_STRICT=1 the legacy expression is not used meanwhile.
import {useCallback,useEffect,useRef,useState} from 'react';
import {REFETCH_DEBOUNCE_MS,LAZY_STRICT} from './use-attendance';
import type {GymState} from './lib/domain';
export const REPORT_PAYMENTS_ON=process.env.NEXT_PUBLIC_GYMOS_REPORT_PAYMENTS==='1';
export type ReportPaymentRow={payment:{id:string;day:string;member:string;method:string;voided:boolean};name:string|null;breakdown:{membership:number;coaching:number;credit:number}};
type Cur={day:string;pos:number;id:string};
type Got={owner:string;branch:string;from:string;to:string;forState:GymState;rows:ReportPaymentRow[];version:string};
export const PULL_DEADLINE_MS=45000; // whole-pull budget (judgment). Past it the screen shows 'range too large, narrow it' with Retry: rows are never truncated silently.
export const MAX_RETAINED_ROWS=50000; // explicit retained-row bound (judgment): past it the range is 'tooLarge' (narrow the dates), never silently cut.
export type Pulled={rows:ReportPaymentRow[];version:string}|'same'|'tooLarge'|{unsupported:string}|null;
const DAY=/^\d{4}-\d\d-\d\d$/;
export function chooseReportPayments(on:boolean,got:Got|null,state:GymState,owner:string,branch:string,from:string,to:string):ReportPaymentRow[]|null{
  return on&&got&&got.owner===owner&&got.branch===branch&&got.from===from&&got.to===to&&got.forState===state?got.rows:null;
}
export {LAZY_STRICT};
/** `known`: the version of the rows already held for this exact range. A first page with that version answers 'same' (no further pages): state changes that did not touch this owner cost one page. */
export async function pullReportPayments(owner:string,branch:string,from:string,to:string,signal?:AbortSignal,known?:string,deadlineMs=PULL_DEADLINE_MS,now:()=>number=Date.now):Promise<Pulled>{
  const t0=now();
  const base='/api/workspace/report-payments?branch='+encodeURIComponent(branch)+'&from='+from+'&to='+to;
  for(let attempt=0;attempt<3;attempt++){
    const rows:ReportPaymentRow[]=[];let url=base,version='',restart=false;
    for(;;){
      let d:{status?:string;version?:string;rows?:ReportPaymentRow[];next?:Cur|null}|null=null;
      try{const r=await fetch(url,{headers:{'X-GymOS-Tenant':owner},cache:'no-store',signal});if(!r.ok&&r.status===503){const j=await r.json().catch(()=>null);if(j&&j.error==='budget')return'tooLarge';}d=r.ok?await r.json():null;}catch{return null;}
      if(!d)return null;if(d.status==='stale'){restart=true;break;}
      if(d.status==='unavailable')return{unsupported:typeof (d as {reason?:string}).reason==='string'?(d as {reason?:string}).reason as string:'unsupported'}; // deterministic: this branch holds a record the lazy view cannot show exactly; Retry cannot change it
      if(d.status!=='ok'||!Array.isArray(d.rows)||typeof d.version!=='string'||(version&&d.version!==version))return null;
      if(!version&&known!==undefined&&d.version===known)return'same';
      version=d.version;rows.push(...d.rows);if(rows.length>MAX_RETAINED_ROWS)return'tooLarge';if(!d.next)return{rows,version};
      if(now()-t0>=deadlineMs)return'tooLarge';
      url=base+'&after='+d.next.day+'&afterPos='+d.next.pos+'&afterId='+encodeURIComponent(d.next.id)+'&ver='+encodeURIComponent(version);
    }
    if(!restart)return null;
  }
  return null;
}
export function useReportPayments(state:GymState,owner:string,branch:string,from:string,to:string):{rows:ReportPaymentRow[]|null;failed:boolean;tooLarge:boolean;unsupported:boolean;loading:boolean;retry:()=>void}{
  const [got,setGot]=useState<Got|null>(null),[failedFor,setFailedFor]=useState<GymState|null>(null),[bigFor,setBigFor]=useState<GymState|null>(null),[unsupFor,setUnsupFor]=useState<GymState|null>(null),[bump,setBump]=useState(0);
  // heldRef tracks the committed value synchronously (a passive effect sync lags a commit). commit() is the only writer.
  const heldRef=useRef<Got|null>(null);
  const commit=useCallback((v:Got|null)=>{heldRef.current=v;setGot(v);},[]);
  const retry=useCallback(()=>setBump(n=>n+1),[]);
  const valid=REPORT_PAYMENTS_ON&&DAY.test(from)&&DAY.test(to)&&Boolean(owner);
  useEffect(()=>{
    if(!valid)return;const ac=new AbortController();
    const timer=setTimeout(()=>{(async()=>{const held=heldRef.current,same=held&&held.owner===owner&&held.branch===branch&&held.from===from&&held.to===to,res=await pullReportPayments(owner,branch,from,to,ac.signal,same?held.version:undefined);if(ac.signal.aborted)return;
      if(res==='same'&&held){commit({...held,forState:state});setFailedFor(null);setBigFor(null);setUnsupFor(null);}
      else if(res==='tooLarge'){commit(null);setBigFor(state);setUnsupFor(null);setFailedFor(state);}
      else if(res&&typeof res==='object'&&'unsupported' in res){commit(null);setBigFor(null);setUnsupFor(state);setFailedFor(state);}
      else if(res&&res!=='same'&&'rows' in res){commit({owner,branch,from,to,forState:state,rows:res.rows,version:res.version});setFailedFor(null);setBigFor(null);setUnsupFor(null);}
      else{commit(null);setBigFor(null);setUnsupFor(null);setFailedFor(state);}})();},bump?0:REFETCH_DEBOUNCE_MS);
    return()=>{clearTimeout(timer);ac.abort();};
   
  },[valid,owner,branch,from,to,state,bump,commit]);
  const rows=valid?chooseReportPayments(true,got,state,owner,branch,from,to):null;
  return{rows,failed:valid&&failedFor!==null&&failedFor===state,tooLarge:valid&&bigFor!==null&&bigFor===state,unsupported:valid&&unsupFor!==null&&unsupFor===state,loading:valid&&!rows&&failedFor!==state,retry};
}
