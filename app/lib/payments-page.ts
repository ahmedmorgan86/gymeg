// Bounded reads for the branch payment consumers of the dashboard: the month collection total, the money trend chart and the payments CSV export.
// Legacy (packet): payments=state.payments.filter(branch); month total = non-voided payments with day.startsWith('YYYY-MM') summed with +; trend value per day =
// non-voided payments with day===that day summed as +minor/100 in packet (position) order; CSV = every branch payment in packet order with the branch member's name/demo.
// Summary: only the rows of the requested day range of that branch (canonical-day partial index), reduced here with the SAME JS arithmetic, never a SQL sum.
// Export: keyset pages of PAYMENTS_PAGE (position, entity_id), a transfer chunk, not a limit; pages carry the owner version of page 1.
// Anything this cannot answer exactly (a non-canonical `day` in the branch's payments, a non-numeric minor, a non-boolean voided flag) is reported 'unavailable' with a reason:
// the caller keeps the packet expression. No quiet zero.
import {boundedRead,indexProbe} from './bounded-read.ts';
import {readOwnerVersion} from './member-summary-store.ts';
import {addDays} from './domain.ts';
import type {Scope} from './member-console-source.ts';
export const PAYMENTS_PAGE=500; // transfer chunk (judgment)
export const SUMMARY_CHUNK=1000; // rows per read inside one summary (judgment; memory bound, not a data limit)
export const SUMMARY_DEADLINE_MS=4000; // whole-loop budget for one summary request (judgment); past it the answer is 'unavailable' and the screen keeps the packet expression, so no result is lost and the pooled connection is released
export const PERIOD_MAX=3660; // input sanity for the chart period (the UI offers a few fixed values), not a data limit
export type Cursor={pos:number;id:string};
export type SummaryData={status:'ok';version:string;trend:number[];monthSum:number}|{status:'stale'}|{status:'unavailable';reason?:string};
export type ExportRow={payment:Record<string,unknown>;member:{name:unknown;demo:unknown}|null};
export type ExportData={status:'ok';version:string;rows:ExportRow[];next:Cursor|null}|{status:'stale'}|{status:'unavailable';reason?:string};
const DAY_RE=`'^\\d{4}-\\d\\d-\\d\\d$'`;
const OFFSHAPE=`(jsonb_typeof(payload->'minor') IS DISTINCT FROM 'number' OR jsonb_typeof(payload->'voided') NOT IN ('boolean','null'))`;
export async function readPaymentsSummary(scope:Scope,q:{owner:string;branch:string;today:string;period:number;deadlineMs?:number;now?:()=>number}):Promise<SummaryData>{
  if(!q.branch||q.branch.length>200||!/^\d{4}-\d\d-\d\d$/.test(q.today)||!Number.isSafeInteger(q.period)||q.period<1||q.period>PERIOD_MAX)throw new RangeError('invalid');
  const days=Array.from({length:q.period},(_,i)=>addDays(q.today,i-q.period+1)),month=q.today.slice(0,7);
  return scope(q.owner,c=>boundedRead(c,q.owner,'paysum\u0000'+q.branch+'\u0000'+q.today+'\u0000'+q.period,async()=>{
    const ver=await readOwnerVersion(c,q.owner);if(ver===null)return{status:'unavailable',reason:'no-version'} as const;
    const odd=(await indexProbe(c,()=>c.query(`SELECT EXISTS(SELECT 1 FROM gymos.gym_entities WHERE owner_id=$1 AND branch=$2 AND pay_day_odd) AS x`,[q.owner,q.branch]))).rows[0] as {x:boolean};
    if(odd.x)return{status:'unavailable',reason:'non-canonical-day'} as const;
    const lo=days.reduce((a,b)=>a<b?a:b,month+'-00'),hi=days.reduce((a,b)=>a>b?a:b,month+'-99');
    // Streamed in keyset chunks of SUMMARY_CHUNK rows ordered (day, position, entity_id) = the index order, so memory is O(chunk + period) however many payments the window holds.
    // Per day the rows arrive in packet order (position, entity_id), so each day's float sum `acc+minor/100` is the legacy reduce exactly. The month total is accumulated in day order:
    // identical to the legacy packet-order sum only when every addend is an integer and every partial sum is exact (|sum| <= 2^53), so any non-integer minor answers 'unavailable' (packet path).
    const now=q.now??Date.now,t0=now(),budget=q.deadlineMs??SUMMARY_DEADLINE_MS;
    const acc=new Map<string,number>(days.map(d=>[d,0])),inWindow=new Set(days);let monthSum=0,cur=null as {day:string;pos:number;id:string}|null;
    for(;;){
      const args:unknown[]=[q.owner,q.branch,lo,hi];let after='';if(cur){args.push(cur.day,cur.pos,cur.id);after=` AND ((payload->>'day') COLLATE "C",position,entity_id) > ($5::text COLLATE "C",$6::bigint,$7::text)`;}
      const rows=(await c.query(`SELECT payload,position,entity_id,${OFFSHAPE} AS odd FROM gymos.gym_entities WHERE owner_id=$1 AND collection='payments' AND branch=$2 AND payload->>'day' ~ ${DAY_RE} AND (payload->>'day') COLLATE "C" >= ($3::text COLLATE "C") AND (payload->>'day') COLLATE "C" <= ($4::text COLLATE "C")${after} ORDER BY (payload->>'day') COLLATE "C",position,entity_id LIMIT ${SUMMARY_CHUNK}`,args)).rows as {payload:{day:string;minor:number;voided?:unknown};position:number;entity_id:string;odd:boolean}[];
      for(const r of rows){
        if(r.odd)return{status:'unavailable',reason:'invalid-payment'} as const;
        const p=r.payload;if(p.voided)continue;
        if(inWindow.has(p.day))acc.set(p.day,acc.get(p.day)!+p.minor/100);
        if(p.day.startsWith(month)){if(!Number.isInteger(p.minor))return{status:'unavailable',reason:'non-integer-minor'} as const;monthSum+=p.minor;if(!Number.isSafeInteger(monthSum))return{status:'unavailable',reason:'month-total-inexact'} as const;}
      }
      if(rows.length<SUMMARY_CHUNK)break;
      if(now()-t0>=budget)return{status:'unavailable',reason:'deadline'} as const; // before the next chunk: stop scanning, release the connection
      if((await readOwnerVersion(c,q.owner))!==ver)return{status:'stale'} as const; // a writer committed: the answer would be discarded anyway
      const l=rows[rows.length-1];cur={day:l.payload.day,pos:Number(l.position),id:l.entity_id};
    }
    const trend=days.map(d=>acc.get(d)!);
    if((await readOwnerVersion(c,q.owner))!==ver)return{status:'stale'} as const;
    return{status:'ok',version:ver,trend,monthSum} as const;
  },o=>o.status==='ok'));
}
export async function readPaymentsExport(scope:Scope,q:{owner:string;branch:string;after?:Cursor;ver?:string}):Promise<ExportData>{
  if(!q.branch||q.branch.length>200||(q.after!==undefined&&(!Number.isSafeInteger(q.after.pos)||!q.after.id||q.after.id.length>200||typeof q.ver!=='string')))throw new RangeError('invalid');
  return scope(q.owner,c=>boundedRead(c,q.owner,'payexp\u0000'+q.branch+'\u0000'+(q.after?q.after.pos+'\u0000'+q.after.id+'\u0000'+q.ver:''),async()=>{
    const ver=await readOwnerVersion(c,q.owner);if(ver===null)return{status:'unavailable',reason:'no-version'} as const;
    if(q.after&&q.ver!==ver)return{status:'stale'} as const;
    const args:unknown[]=[q.owner,q.branch];let cur='';if(q.after){args.push(q.after.pos,q.after.id);cur=' AND (p.position,p.entity_id)>($3::bigint,$4::text)';}
    const rows=(await c.query(`SELECT p.payload,p.position,p.entity_id,m.payload->'name' AS mname,m.payload->'demo' AS mdemo,(m.entity_id IS NOT NULL) AS mfound FROM gymos.gym_entities p LEFT JOIN gymos.gym_entities m ON m.owner_id=p.owner_id AND m.collection='members' AND m.entity_id=p.payload->>'member' AND m.branch=$2 WHERE p.owner_id=$1 AND p.collection='payments' AND p.branch=$2${cur} ORDER BY p.position,p.entity_id LIMIT ${PAYMENTS_PAGE+1}`,args)).rows as {payload:Record<string,unknown>;position:number;entity_id:string;mname:unknown;mdemo:unknown;mfound:boolean}[];
    if((await readOwnerVersion(c,q.owner))!==ver)return{status:'stale'} as const;
    const more=rows.length>PAYMENTS_PAGE,page=more?rows.slice(0,PAYMENTS_PAGE):rows,last=page[page.length-1];
    return{status:'ok',version:ver,rows:page.map(r=>({payment:r.payload,member:r.mfound?{name:r.mname,demo:r.mdemo}:null})),next:more?{pos:Number(last.position),id:last.entity_id}:null} as const;
  },o=>o.status==='ok'));
}
