import {createHash} from 'node:crypto';
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
export const REPORT_CAND_SQL=`SELECT c.eid,c.position,c.voided,c.category,c.hits,(SELECT jsonb_object_agg(x.pay,x.arr) FROM (SELECT y.pay,jsonb_agg(y.elem ORDER BY y.ord) AS arr FROM (SELECT a.v->>'payment' AS pay,a.ord,jsonb_build_object('payment',a.v->'payment') || CASE WHEN a.v ? 'minor' THEN jsonb_build_object('minor',a.v->'minor') ELSE '{}'::jsonb END AS elem FROM jsonb_array_elements(c.al) WITH ORDINALITY a(v,ord) WHERE jsonb_typeof(a.v)='object' AND jsonb_typeof(a.v->'payment')='string' AND a.v->>'payment'=ANY($4::text[])) y GROUP BY y.pay) x) AS al\n  FROM (SELECT i.entity_id AS eid,i.position,i.payload->'voided' AS voided,i.payload->'category' AS category,i.payload->'allocations' AS al,ARRAY(SELECT k FROM unnest(gymos.invoice_alloc_keys(i.owner_id,i.payload)) k WHERE k=ANY($3::text[])) AS hits\n    FROM gymos.gym_entities i WHERE i.owner_id=$1 AND i.collection='invoices' AND i.entity_id IN (SELECT DISTINCT g.entity_id FROM (SELECT array_agg(u.k) AS k FROM unnest($3::text[]) WITH ORDINALITY u(k,ord) GROUP BY (u.ord-1)/20) k CROSS JOIN LATERAL (SELECT x.entity_id FROM gymos.gym_entities x WHERE x.owner_id=$1 AND x.collection='invoices' AND jsonb_typeof(x.payload->'allocations')='array' AND ($2::text[] IS NULL OR x.branch=ANY($2::text[])) AND gymos.invoice_alloc_keys(x.owner_id,x.payload) && k.k OFFSET 0) g)) c ORDER BY c.position,c.eid`;
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
    // Two reads on the same scope. (1) the page of payments. (2) the invoices any page payment may touch, each EXPANDED ONCE: the candidate set is deduplicated across the page by the owner-keyed GIN probe (branch scope as in the caller's packet),
    // and from each invoice's allocation array only the elements whose payment id is on the page (a hashed ANY over the page ids) travel, grouped by payment id with their original order. The page's invoices are re-assembled per payment
    // in (position, entity_id) order in JS, so every payment's input to paymentBreakdown is what the former per-payment probe produced.
    const rows=(await c.query(`SELECT p.owner_id,p.payload,p.position,p.entity_id,m.payload->>'name' AS mname,jsonb_typeof(m.payload->'name') AS mtype,(m.entity_id IS NOT NULL) AS mfound
      FROM gymos.gym_entities p LEFT JOIN gymos.gym_entities m ON m.owner_id=p.owner_id AND m.collection='members' AND m.entity_id=p.payload->>'member' AND ($5::text[] IS NULL OR m.branch=ANY($5::text[]))
      WHERE p.owner_id=$1 AND p.collection='payments' AND p.branch=$2 AND p.payload->>'day' ~ '^\\d{4}-\\d\\d-\\d\\d$' AND (p.payload->>'day') COLLATE "C" >= ($3::text COLLATE "C") AND (p.payload->>'day') COLLATE "C" <= ($4::text COLLATE "C")${after}
      ORDER BY (p.payload->>'day') COLLATE "C",p.position,p.entity_id LIMIT ${REPORT_PAGE+1}`,args)).rows as {payload:Payment;position:number;entity_id:string;mname:string|null;mtype:string|null;mfound:boolean;invoices:unknown[]}[];
    const more=rows.length>REPORT_PAGE,page=more?rows.slice(0,REPORT_PAGE):rows;
    for(const r of page)if(typeof r.payload.id!=='string')return{status:'unavailable',reason:'payment-id'} as const;
    const ids=[...new Set(page.map(r=>r.payload.id))],keyOf=(id:string)=>createHash('md5').update(q.owner+'|'+id).digest('hex');
    const keys=ids.map(keyOf);
    const cand=ids.length===0?[]:(await c.query(REPORT_CAND_SQL,[q.owner,bl,keys,ids])).rows as {eid:string;position:number;voided:unknown;category:unknown;hits:string[];al:Record<string,unknown[]>|null}[];
    for(const r of page)(r as {invoices:unknown[]}).invoices=cand.filter(x=>x.hits.includes(keyOf(r.payload.id))).map(x=>({voided:x.voided,category:x.category,allocations:(x.al&&Object.prototype.hasOwnProperty.call(x.al,r.payload.id)?x.al[r.payload.id]:[])}));
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

// Candidate reader over the held plain-column keys (migration 20261122030000: pay_day / pay_day_odd on payments, gymos.invoice_allocation_refs). Selected by GYMOS_REPORT_PAYMENTS_REFS=1 (default OFF, only after the migration,
// its backfill and the zero-mismatch readiness are in place; it answers 'unavailable' until invoice_allocation_refs_state says complete). Every predicate is a plain column compare (texteq/ordering, leakproof), so under FORCE RLS they can be
// Index Cond. Same results as readReportPayments: page of payments by (pay_day C, position, entity_id); member names by entity_id = ANY(page members); allocation elements of the page's payment ids from the refs (exact payment_id equality
// repeated on top of the md5 key), the invoices' voided/category by pkey = ANY; per payment the invoices in (position, entity_id) order with their elements in source order.
export async function readReportPaymentsRefs(scope:Scope,q:{owner:string;branch:string;branches?:string[]|null;from:string;to:string;after?:Cursor;ver?:string}):Promise<ReportPayments>{
  if(!q.branch||q.branch.length>200||!DAY.test(q.from)||!DAY.test(q.to)||(q.after!==undefined&&(!DAY.test(q.after.day)||!Number.isSafeInteger(q.after.pos)||!q.after.id||q.after.id.length>200||typeof q.ver!=='string')))throw new RangeError('invalid');
  const bl=q.branches??null;
  return scope(q.owner,c=>boundedRead(c,q.owner,'repayR\u0000'+q.branch+'\u0000'+JSON.stringify(bl)+'\u0000'+q.from+'\u0000'+q.to+'\u0000'+(q.after?q.after.day+'\u0000'+q.after.pos+'\u0000'+q.after.id+'\u0000'+q.ver:''),async()=>{
    const ver=await readOwnerVersion(c,q.owner);if(ver===null)return{status:'unavailable',reason:'no-version'} as const;
    if(q.after&&q.ver!==ver)return{status:'stale'} as const;
    const ready=(await c.query(`SELECT EXISTS(SELECT 1 FROM gymos.invoice_allocation_refs_state WHERE key='complete') AS x`)).rows[0] as {x:boolean};
    if(!ready.x)return{status:'unavailable',reason:'refs-not-ready'} as const;
    const odd=(await indexProbe(c,()=>c.query(`SELECT EXISTS(SELECT 1 FROM gymos.gym_entities WHERE owner_id=$1 AND branch=$2 AND pay_day_odd) AS x`,[q.owner,q.branch]))).rows[0] as {x:boolean};
    if(odd.x)return{status:'unavailable',reason:'non-canonical-day'} as const;
    const args:unknown[]=[q.owner,q.branch,q.from,q.to];let after='';
    if(q.after){args.push(q.after.day,q.after.pos,q.after.id);after=` AND (pay_day,position,entity_id) > ($5::text COLLATE "C",$6::integer,$7::text)`;}
    const rows=(await c.query(`SELECT payload,position,entity_id,pay_day FROM gymos.gym_entities WHERE owner_id=$1 AND collection='payments' AND branch=$2 AND pay_day >= $3::text COLLATE "C" AND pay_day <= $4::text COLLATE "C"${after} ORDER BY pay_day,position,entity_id LIMIT ${REPORT_PAGE+1}`,args)).rows as {payload:Payment;position:number;entity_id:string}[];
    const more=rows.length>REPORT_PAGE,page=more?rows.slice(0,REPORT_PAGE):rows;
    for(const r of page)if(typeof r.payload.id!=='string')return{status:'unavailable',reason:'payment-id'} as const;
    const ids=[...new Set(page.map(r=>r.payload.id))],members=[...new Set(page.map(r=>r.payload.member).filter((m):m is string=>typeof m==='string'))];
    const names=new Map<string,{n:string|null;t:string|null}>();
    if(members.length)for(const m of (await c.query(`SELECT entity_id,payload->>'name' AS n,jsonb_typeof(payload->'name') AS t FROM gymos.gym_entities WHERE owner_id=$1 AND collection='members' AND entity_id=ANY($2::text[]) AND ($3::text[] IS NULL OR branch=ANY($3::text[]))`,[q.owner,members,bl])).rows as {entity_id:string;n:string|null;t:string|null}[])names.set(m.entity_id,{n:m.n,t:m.t});
    const els=ids.length?(await c.query(`SELECT invoice_id,invoice_position,ord,payment_id,has_minor,minor FROM gymos.invoice_allocation_refs WHERE owner_id=$1 AND payment_key=ANY($2::text[]) AND payment_id=ANY($3::text[]) AND ($4::text[] IS NULL OR invoice_branch=ANY($4::text[])) ORDER BY invoice_position,invoice_id,ord`,[q.owner,ids.map(id=>createHash('md5').update(id).digest('hex')),ids,bl])).rows as {invoice_id:string;invoice_position:number;ord:number;payment_id:string;has_minor:boolean;minor:unknown}[]:[];
    const invIds=[...new Set(els.map(e=>e.invoice_id))];
    const inv=new Map<string,{voided:unknown;category:unknown}>();
    if(invIds.length)for(const i of (await c.query(`SELECT entity_id,payload->'voided' AS voided,payload->'category' AS category FROM gymos.gym_entities WHERE owner_id=$1 AND collection='invoices' AND entity_id=ANY($2::text[])`,[q.owner,invIds])).rows as {entity_id:string;voided:unknown;category:unknown}[])inv.set(i.entity_id,{voided:i.voided,category:i.category});
    const byPay=new Map<string,Map<string,{pos:number;id:string;allocations:unknown[]}>>();
    for(const e of els){let m=byPay.get(e.payment_id);if(!m)byPay.set(e.payment_id,m=new Map());let g=m.get(e.invoice_id);if(!g)m.set(e.invoice_id,g={pos:e.invoice_position,id:e.invoice_id,allocations:[]});g.allocations.push({payment:e.payment_id,...(e.has_minor?{minor:e.minor}:{})});}
    const out:ReportPaymentRow[]=[];
    for(const r of page){
      const nm=typeof r.payload.member==='string'?names.get(r.payload.member):undefined;
      if(nm&&nm.t!==null&&nm.t!=='null'&&nm.t!=='string')return{status:'unavailable',reason:'member-name'} as const;
      const invs=[...(byPay.get(r.payload.id)?.values()??[])].sort((a,b)=>a.pos-b.pos||(a.id<b.id?-1:a.id>b.id?1:0)).map(g=>({...(inv.get(g.id)??{voided:undefined,category:undefined}),allocations:g.allocations}));
      const breakdown=paymentBreakdown({invoices:invs} as unknown as GymState,r.payload);
      out.push({payment:{id:r.payload.id,day:r.payload.day,member:r.payload.member,method:r.payload.method,voided:r.payload.voided},name:nm&&nm.t==='string'?nm.n:null,breakdown});
    }
    if((await readOwnerVersion(c,q.owner))!==ver)return{status:'stale'} as const;
    const last=page[page.length-1];
    return{status:'ok',version:ver,rows:out,next:more?{day:last.payload.day,pos:Number(last.position),id:last.entity_id}:null} as const;
  },o=>o.status==='ok'));
}
