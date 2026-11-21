// Bounded read for the Reports "Collections & receipts" payment rows: the branch's payments of a day range with each payment's allocation breakdown and the member's name.
// Legacy (reports-page): for p of s.payments (branch) -> paymentBreakdown(s,p) loops EVERY invoice of the packet and every allocation, keeps categories with amount>0, name = member found among the
// packet's members, then day>=from&&day<=to. Here: the payments of the range in keyset pages of REPORT_PAGE ordered (day C, position, entity_id); per payment ONLY the invoices whose allocations
// contain that payment id (an owner-keyed GIN probe, then the exact jsonb containment test; a branch-limited caller only sees invoices of its branches, as in its packet); the breakdown is the SAME paymentBreakdown code
// run over those invoices, so every JS quirk is preserved. The browser keeps its own filter, search, kind totals, paging and localeCompare ordering over the rows it receives.
// Not exact => 'unavailable' (the screen keeps the packet expression): a non-canonical payment day in the branch, a non-string payment id, or a member whose name is neither a string nor null/absent. Per payment only the fields paymentBreakdown reads travel from SQL: each matching invoice's voided/category and ONLY its allocation elements for that payment id (payment, minor; `minor` present only when it is, since absent => NaN but null => 0 in legacy), so the intermediate size is bounded by the payment's own allocations, never by a bulk invoice.
import {boundedRead,indexProbe} from './bounded-read.ts';
import {readOwnerVersion} from './member-summary-store.ts';
import {paymentBreakdown} from './member-ledger.ts';
import type {Scope} from './member-console-source.ts';
import type {GymState,Payment} from './domain.ts';
export const REPORT_PAGE=500; // transfer chunk (judgment), not a limit
export type Cursor={day:string;pos:number;id:string};
export type ReportPaymentRow={payment:{id:string;day:string;member:string;method:unknown;voided:unknown};name:string|null;breakdown:{membership:number;coaching:number;credit:number}};
export type ReportPayments={status:'ok';version:string;rows:ReportPaymentRow[];next:Cursor|null}|{status:'stale'}|{status:'unavailable';reason?:string};
const DAY=/^\d{4}-\d\d-\d\d$/;
export async function readReportPayments(scope:Scope,q:{owner:string;branch:string;branches?:string[]|null;from:string;to:string;after?:Cursor;ver?:string}):Promise<ReportPayments>{
  if(!q.branch||q.branch.length>200||!DAY.test(q.from)||!DAY.test(q.to)||(q.after!==undefined&&(!DAY.test(q.after.day)||!Number.isSafeInteger(q.after.pos)||!q.after.id||q.after.id.length>200||typeof q.ver!=='string')))throw new RangeError('invalid');
  const bl=q.branches??null;
  return scope(q.owner,c=>boundedRead(c,q.owner,'repay\u0000'+q.branch+'\u0000'+JSON.stringify(bl)+'\u0000'+q.from+'\u0000'+q.to+'\u0000'+(q.after?q.after.day+'\u0000'+q.after.pos+'\u0000'+q.after.id+'\u0000'+q.ver:''),async()=>{
    const ver=await readOwnerVersion(c,q.owner);if(ver===null)return{status:'unavailable',reason:'no-version'} as const;
    if(q.after&&q.ver!==ver)return{status:'stale'} as const;
    const odd=(await indexProbe(c,()=>c.query(`SELECT EXISTS(SELECT 1 FROM gymos.gym_entities WHERE owner_id=$1 AND collection='payments' AND branch=$2 AND (jsonb_typeof(payload->'day') IS DISTINCT FROM 'string' OR payload->>'day' !~ '^\\d{4}-\\d\\d-\\d\\d$')) AS x`,[q.owner,q.branch]))).rows[0] as {x:boolean};
    if(odd.x)return{status:'unavailable',reason:'non-canonical-day'} as const;
    const args:unknown[]=[q.owner,q.branch,q.from,q.to,bl];let after='';
    if(q.after){args.push(q.after.day,q.after.pos,q.after.id);after=` AND ((p.payload->>'day') COLLATE "C",p.position,p.entity_id) > ($6::text COLLATE "C",$7::bigint,$8::text)`;}
    const rows=(await c.query(`SELECT p.payload,p.position,p.entity_id,m.payload->>'name' AS mname,jsonb_typeof(m.payload->'name') AS mtype,(m.entity_id IS NOT NULL) AS mfound,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('voided',i.payload->'voided','category',i.payload->'category','allocations',(SELECT COALESCE(jsonb_agg(jsonb_build_object('payment',a->'payment') || CASE WHEN a ? 'minor' THEN jsonb_build_object('minor',a->'minor') ELSE '{}'::jsonb END),'[]'::jsonb) FROM jsonb_array_elements(i.payload->'allocations') a WHERE jsonb_typeof(a)='object' AND a->'payment' = p.payload->'id')) ORDER BY i.position,i.entity_id) FROM gymos.gym_entities i WHERE i.owner_id=p.owner_id AND i.collection='invoices' AND gymos.invoice_alloc_keys(i.owner_id,i.payload) @> ARRAY[md5(p.owner_id||'|'||(p.payload->>'id'))] AND jsonb_typeof(i.payload->'allocations')='array' AND ($5::text[] IS NULL OR i.branch=ANY($5::text[]))),'[]'::jsonb) AS invoices
      FROM gymos.gym_entities p LEFT JOIN gymos.gym_entities m ON m.owner_id=p.owner_id AND m.collection='members' AND m.entity_id=p.payload->>'member' AND ($5::text[] IS NULL OR m.branch=ANY($5::text[]))
      WHERE p.owner_id=$1 AND p.collection='payments' AND p.branch=$2 AND p.payload->>'day' ~ '^\\d{4}-\\d\\d-\\d\\d$' AND (p.payload->>'day') COLLATE "C" >= ($3::text COLLATE "C") AND (p.payload->>'day') COLLATE "C" <= ($4::text COLLATE "C")${after}
      ORDER BY (p.payload->>'day') COLLATE "C",p.position,p.entity_id LIMIT ${REPORT_PAGE+1}`,args)).rows as {payload:Payment;position:number;entity_id:string;mname:string|null;mtype:string|null;mfound:boolean;invoices:unknown[]}[];
    const more=rows.length>REPORT_PAGE,page=more?rows.slice(0,REPORT_PAGE):rows;
    const out:ReportPaymentRow[]=[];
    for(const r of page){
      if(typeof r.payload.id!=='string')return{status:'unavailable',reason:'payment-id'} as const;
      if(r.mfound&&r.mtype!==null&&r.mtype!=='null'&&r.mtype!=='string')return{status:'unavailable',reason:'member-name'} as const; // legacy would show a non-string name (and throw in its search): refuse, never null it
      const breakdown=paymentBreakdown({invoices:r.invoices} as unknown as GymState,r.payload);
      out.push({payment:{id:r.payload.id,day:r.payload.day,member:r.payload.member,method:r.payload.method,voided:r.payload.voided},name:r.mfound&&r.mtype==='string'?r.mname:null,breakdown});
    }
    if((await readOwnerVersion(c,q.owner))!==ver)return{status:'stale'} as const;
    const last=page[page.length-1];
    return{status:'ok',version:ver,rows:out,next:more?{day:last.payload.day,pos:Number(last.position),id:last.entity_id}:null} as const;
  },o=>o.status==='ok'));
}
