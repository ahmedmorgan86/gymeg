"use client";
// OFF (default): the Reports page builds payment rows from the packet (paymentBreakdown over every invoice). ON (NEXT_PUBLIC_GYMOS_REPORT_PAYMENTS=1): the branch's payments of the chosen day range
// (with breakdown and member name) are pulled in keyset pages at one owner version (a stale page restarts, 3 attempts), used only for THIS state object, owner, branch and range.
// The page keeps its own filter, search, totals, paging and ordering over these rows. A failure shows a visible Retry; with NEXT_PUBLIC_GYMOS_LAZY_STRICT=1 the legacy expression is not used meanwhile.
import {useCallback,useEffect,useState} from 'react';
import {REFETCH_DEBOUNCE_MS,LAZY_STRICT} from './use-attendance';
import type {GymState} from './lib/domain';
export const REPORT_PAYMENTS_ON=process.env.NEXT_PUBLIC_GYMOS_REPORT_PAYMENTS==='1';
export type ReportPaymentRow={payment:{id:string;day:string;member:string;method:string;voided:boolean};name:string|null;breakdown:{membership:number;coaching:number;credit:number}};
type Cur={day:string;pos:number;id:string};
type Got={owner:string;branch:string;from:string;to:string;forState:GymState;rows:ReportPaymentRow[]};
const DAY=/^\d{4}-\d\d-\d\d$/;
export function chooseReportPayments(on:boolean,got:Got|null,state:GymState,owner:string,branch:string,from:string,to:string):ReportPaymentRow[]|null{
  return on&&got&&got.owner===owner&&got.branch===branch&&got.from===from&&got.to===to&&got.forState===state?got.rows:null;
}
export {LAZY_STRICT};
export async function pullReportPayments(owner:string,branch:string,from:string,to:string,signal?:AbortSignal):Promise<ReportPaymentRow[]|null>{
  const base='/api/workspace/report-payments?branch='+encodeURIComponent(branch)+'&from='+from+'&to='+to;
  for(let attempt=0;attempt<3;attempt++){
    const rows:ReportPaymentRow[]=[];let url=base,version='',restart=false;
    for(;;){
      let d:{status?:string;version?:string;rows?:ReportPaymentRow[];next?:Cur|null}|null=null;
      try{const r=await fetch(url,{headers:{'X-GymOS-Tenant':owner},cache:'no-store',signal});d=r.ok?await r.json():null;}catch{return null;}
      if(!d)return null;if(d.status==='stale'){restart=true;break;}
      if(d.status!=='ok'||!Array.isArray(d.rows)||typeof d.version!=='string'||(version&&d.version!==version))return null;
      version=d.version;rows.push(...d.rows);if(!d.next)return rows;
      url=base+'&after='+d.next.day+'&afterPos='+d.next.pos+'&afterId='+encodeURIComponent(d.next.id)+'&ver='+encodeURIComponent(version);
    }
    if(!restart)return null;
  }
  return null;
}
export function useReportPayments(state:GymState,owner:string,branch:string,from:string,to:string):{rows:ReportPaymentRow[]|null;failed:boolean;loading:boolean;retry:()=>void}{
  const [got,setGot]=useState<Got|null>(null),[failedFor,setFailedFor]=useState<GymState|null>(null),[bump,setBump]=useState(0);
  const retry=useCallback(()=>setBump(n=>n+1),[]);
  const valid=REPORT_PAYMENTS_ON&&DAY.test(from)&&DAY.test(to)&&Boolean(owner);
  useEffect(()=>{
    if(!valid)return;const ac=new AbortController();
    const timer=setTimeout(()=>{(async()=>{const rows=await pullReportPayments(owner,branch,from,to,ac.signal);if(ac.signal.aborted)return;
      if(rows){setGot({owner,branch,from,to,forState:state,rows});setFailedFor(null);}else{setGot(null);setFailedFor(state);}})();},bump?0:REFETCH_DEBOUNCE_MS);
    return()=>{clearTimeout(timer);ac.abort();};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[valid,owner,branch,from,to,state,bump]);
  const rows=valid?chooseReportPayments(true,got,state,owner,branch,from,to):null;
  return{rows,failed:valid&&failedFor!==null&&failedFor===state,loading:valid&&!rows&&failedFor!==state,retry};
}
