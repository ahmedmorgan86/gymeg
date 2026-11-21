// Bounded reads for the branch payment consumers of the dashboard: the month collection total, the money trend chart and the payments CSV export.
// Legacy (packet): payments=state.payments.filter(branch); month total = non-voided payments with day.startsWith('YYYY-MM') summed with +; trend value per day =
// non-voided payments with day===that day summed as +minor/100 in packet (position) order; CSV = every branch payment in packet order with the branch member's name/demo.
// Summary: only the rows of the requested day range of that branch (canonical-day partial index), reduced here with the SAME JS arithmetic, never a SQL sum.
// Export: keyset pages of PAYMENTS_PAGE (position, entity_id), a transfer chunk, not a limit; pages carry the owner version of page 1.
// Anything this cannot answer exactly (a non-canonical `day` in the branch's payments, a non-numeric minor, a non-boolean voided flag) is reported 'unavailable' with a reason:
// the caller keeps the packet expression. No quiet zero.
import {boundedRead} from './bounded-read.ts';
import {readOwnerVersion} from './member-summary-store.ts';
import {addDays} from './domain.ts';
import type {Scope} from './member-console-source.ts';
export const PAYMENTS_PAGE=500; // transfer chunk (judgment)
export const PERIOD_MAX=3660; // input sanity for the chart period (the UI offers a few fixed values), not a data limit
export type Cursor={pos:number;id:string};
export type SummaryData={status:'ok';version:string;trend:number[];monthSum:number}|{status:'stale'}|{status:'unavailable';reason?:string};
export type ExportRow={payment:Record<string,unknown>;member:{name:unknown;demo:unknown}|null};
export type ExportData={status:'ok';version:string;rows:ExportRow[];next:Cursor|null}|{status:'stale'}|{status:'unavailable';reason?:string};
const DAY_RE=`'^\\d{4}-\\d\\d-\\d\\d$'`;
const OFFSHAPE=`(jsonb_typeof(payload->'minor') IS DISTINCT FROM 'number' OR jsonb_typeof(payload->'voided') NOT IN ('boolean','null'))`;
export async function readPaymentsSummary(scope:Scope,q:{owner:string;branch:string;today:string;period:number}):Promise<SummaryData>{
  if(!q.branch||q.branch.length>200||!/^\d{4}-\d\d-\d\d$/.test(q.today)||!Number.isSafeInteger(q.period)||q.period<1||q.period>PERIOD_MAX)throw new RangeError('invalid');
  const days=Array.from({length:q.period},(_,i)=>addDays(q.today,i-q.period+1)),month=q.today.slice(0,7);
  return scope(q.owner,c=>boundedRead(c,q.owner,'paysum\u0000'+q.branch+'\u0000'+q.today+'\u0000'+q.period,async()=>{
    const ver=await readOwnerVersion(c,q.owner);if(ver===null)return{status:'unavailable',reason:'no-version'} as const;
    const odd=(await c.query(`SELECT EXISTS(SELECT 1 FROM gymos.gym_entities WHERE owner_id=$1 AND collection='payments' AND branch=$2 AND (jsonb_typeof(payload->'day') IS DISTINCT FROM 'string' OR payload->>'day' !~ ${DAY_RE})) AS x`,[q.owner,q.branch])).rows[0] as {x:boolean};
    if(odd.x)return{status:'unavailable',reason:'non-canonical-day'} as const;
    const lo=days.reduce((a,b)=>a<b?a:b,month+'-00'),hi=days.reduce((a,b)=>a>b?a:b,month+'-99');
    const rows=(await c.query(`SELECT payload,${OFFSHAPE} AS odd FROM gymos.gym_entities WHERE owner_id=$1 AND collection='payments' AND branch=$2 AND payload->>'day' ~ ${DAY_RE} AND (payload->>'day') COLLATE "C" >= ($3::text COLLATE "C") AND (payload->>'day') COLLATE "C" <= ($4::text COLLATE "C") ORDER BY position,entity_id`,[q.owner,q.branch,lo,hi])).rows as {payload:{day:string;minor:number;voided?:unknown};odd:boolean}[];
    if(rows.some(r=>r.odd))return{status:'unavailable',reason:'invalid-payment'} as const;
    const live=rows.map(r=>r.payload).filter(p=>!p.voided);
    const trend=days.map(day=>live.filter(p=>p.day===day).reduce((v,p)=>v+p.minor/100,0));
    const monthSum=live.filter(p=>p.day.startsWith(month)).reduce((s,p)=>s+p.minor,0);
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
