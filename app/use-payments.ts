"use client";
// OFF (default): the dashboard keeps its packet expressions for the month collection total and the money trend, and the payments CSV is built from the packet.
// ON (NEXT_PUBLIC_GYMOS_PAYMENTS=1): summary (month total + trend) fetched for THIS state object, owner, branch, day and period; null otherwise (caller keeps the legacy expression).
// `exportPayments` pulls every page of one export at one owner version (a stale page restarts, 3 attempts) and resolves rows, or null on failure (caller falls back to the packet).
import {useCallback,useEffect,useState} from 'react';
import {LAZY_STRICT,REFETCH_DEBOUNCE_MS} from './use-attendance';
import type {GymState} from './lib/domain';
export const PAYMENTS_ON=process.env.NEXT_PUBLIC_GYMOS_PAYMENTS==='1';
export type PaymentsSummary={trend:number[];monthSum:number};
export type ExportRow={payment:{day:string;minor:number;method?:string;voided?:boolean;member:string};member:{name?:unknown;demo?:unknown}|null};
type Got={owner:string;branch:string;today:string;period:number;forState:GymState;data:PaymentsSummary};
export function choosePayments(on:boolean,got:Got|null,state:GymState,owner:string,branch:string,today:string,period:number):PaymentsSummary|null{
  return on&&got&&got.owner===owner&&got.branch===branch&&got.today===today&&got.period===period&&got.forState===state&&got.data.trend.length===period?got.data:null;
}
export {LAZY_STRICT};
const H=(owner:string)=>({'X-GymOS-Tenant':owner});
export async function exportPayments(owner:string,branch:string):Promise<ExportRow[]|null>{
  const base='/api/workspace/payments?mode=export&branch='+encodeURIComponent(branch);
  for(let attempt=0;attempt<3;attempt++){
    const rows:ExportRow[]=[];let url=base,version='',restart=false;
    for(;;){
      let d:{status?:string;version?:string;rows?:ExportRow[];next?:{pos:number;id:string}|null}|null=null;
      try{const r=await fetch(url,{headers:H(owner),cache:'no-store'});d=r.ok?await r.json():null;}catch{return null;}
      if(!d)return null;if(d.status==='stale'){restart=true;break;}
      if(d.status!=='ok'||!Array.isArray(d.rows)||typeof d.version!=='string'||(version&&d.version!==version))return null;
      version=d.version;rows.push(...d.rows);
      if(!d.next)return rows;
      url=base+'&after='+d.next.pos+'&afterId='+encodeURIComponent(d.next.id)+'&ver='+encodeURIComponent(version);
    }
    if(!restart)return null;
  }
  return null;
}
export function usePaymentsSummary(active:boolean,state:GymState|undefined,owner:string|undefined,branch:string,today:string,period:number):{data:PaymentsSummary|null;failed:boolean;retry:()=>void}{
  const [got,setGot]=useState<Got|null>(null),[failedFor,setFailedFor]=useState<GymState|null>(null),[bump,setBump]=useState(0);
  const retry=useCallback(()=>setBump(n=>n+1),[]);
  useEffect(()=>{
    if(!PAYMENTS_ON||!active||!owner||!state)return;const ac=new AbortController();
    const fail=()=>{if(!ac.signal.aborted){setGot(null);setFailedFor(state);}};
    const timer=setTimeout(()=>{(async()=>{try{
      const r=await fetch('/api/workspace/payments?mode=summary&branch='+encodeURIComponent(branch)+'&today='+today+'&period='+period,{headers:H(owner),signal:ac.signal,cache:'no-store'});
      const d=r.ok?await r.json() as {status?:string;trend?:number[];monthSum?:number}:null;
      if(d&&d.status==='ok'&&Array.isArray(d.trend)&&typeof d.monthSum==='number'){setGot({owner,branch,today,period,forState:state,data:{trend:d.trend,monthSum:d.monthSum}});setFailedFor(null);return;}
      fail();
    }catch{fail();}})();},bump?0:REFETCH_DEBOUNCE_MS);
    return()=>{clearTimeout(timer);ac.abort();};
   
  },[active,owner,branch,today,period,state,bump]);
  return{data:state?choosePayments(PAYMENTS_ON&&active,got,state,owner??'',branch,today,period):null,failed:PAYMENTS_ON&&active&&failedFor!==null&&failedFor===state,retry};
}
