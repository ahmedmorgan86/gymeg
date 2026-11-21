// Private exact credit. Fast path (GYMOS_CREDIT_REFS=1, default OFF): the allocation refs return only the invoices naming the member's creditable payments (index-driven, no whole-owner scan, no invoice/byte cap) and the unchanged
// memberCredit folds them. The helper refuses anything the refs cannot represent exactly (not ready, odd shapes, string/object minor, tied positions, >500 payment ids, disabled triggers, version change); every refusal falls through
// to the exact whole-owner fold below with its admission bounds (refusal bounds, not capacity acceptance). Do not call this per member in a list (Gather amplification).
import type {GymState} from './domain.ts';
import {memberCredit} from './member-ledger.ts';
import {allocatingInvoicesFromRefs} from './member-credit-refs.ts';
type Q={query(sql:string,v?:unknown[]):Promise<{rows:unknown[]}>};
export const PRIVATE_CREDIT_INVOICE_CAP=10000;
export const PRIVATE_CREDIT_BYTES=2*1024*1024;
export const PRIVATE_CREDIT_FOLD_UNITS=2000000;
export const PRIVATE_CREDIT_FOLD_BYTES=8*1024*1024;
export async function exactPrivateCredit(c:Q,owner:string,payments:GymState['payments'],member:string,branch:string){
 const selected=payments.filter(p=>p.member===member&&p.branch===branch&&p.creditable&&!p.voided);
 if(!selected.length)return{status:'ok',credit:0} as const;
 if(process.env.GYMOS_CREDIT_REFS==='1'){
  const r=await allocatingInvoicesFromRefs(c,owner,selected.map(p=>p.id));
  if(r.status==='ok'){
   // Same accepted admission as the fold below, applied BEFORE the unchanged repeated fold: bytes of the returned allocation slices, and fold units x creditable payments. SQL timeouts do not bound JS CPU.
   let units=r.invoices.length,bytes=0;for(const i of r.invoices){bytes+=Buffer.byteLength(JSON.stringify(i.allocations??null))+Buffer.byteLength(JSON.stringify(i.voided??null))+64;if(!i.voided&&Array.isArray(i.allocations))units+=i.allocations.length;}
   if(bytes>PRIVATE_CREDIT_BYTES)return{status:'unavailable',reason:'credit-byte-cap'} as const;
   if(bytes*selected.length>PRIVATE_CREDIT_FOLD_BYTES)return{status:'unavailable',reason:'credit-fold-byte-cap'} as const;
   if(units*selected.length>PRIVATE_CREDIT_FOLD_UNITS)return{status:'unavailable',reason:'credit-fold-cap'} as const;
   const credit=memberCredit({payments,invoices:r.invoices} as unknown as GymState,member,branch);if(!Number.isFinite(credit))return{status:'unavailable',reason:'credit-nonfinite'} as const;return{status:'ok',credit} as const;}
 }
 // One statement/snapshot: never check bytes then fetch a changed larger projection.
 // A refused budget emits only metadata, not the oversized allocation payload.
 const rows=(await c.query(`WITH projected AS MATERIALIZED (
 SELECT position,entity_id,payload->'allocations' AS allocations,payload->'voided' AS voided
 FROM gymos.gym_entities WHERE owner_id=$1 AND collection='invoices'
 ORDER BY position,entity_id LIMIT ${PRIVATE_CREDIT_INVOICE_CAP+1}
 ), budget AS (SELECT count(*) AS budget_rows,coalesce(sum(octet_length(coalesce(allocations::text,''))+octet_length(coalesce(voided::text,''))+64),0) AS budget_bytes,coalesce(sum(octet_length(coalesce(allocations::text,''))),0) AS budget_fold_bytes FROM projected)
 SELECT budget.budget_rows,budget.budget_bytes,budget.budget_fold_bytes,p.position,p.allocations,p.voided
 FROM budget LEFT JOIN projected p ON budget.budget_rows<=${PRIVATE_CREDIT_INVOICE_CAP} AND budget.budget_bytes<=${PRIVATE_CREDIT_BYTES}
 ORDER BY p.position,p.entity_id`,[owner])).rows as Array<{budget_rows:string|number;budget_bytes:string|number;budget_fold_bytes:string|number;position:unknown;allocations:unknown;voided:unknown}>;
 if(!rows.length)return{status:'unavailable',reason:'credit-budget-missing'} as const;
 if(Number(rows[0].budget_rows)>PRIVATE_CREDIT_INVOICE_CAP)return{status:'unavailable',reason:'credit-invoice-cap'} as const;
 if(!Number.isFinite(Number(rows[0].budget_bytes))||Number(rows[0].budget_bytes)>PRIVATE_CREDIT_BYTES)return{status:'unavailable',reason:'credit-byte-cap'} as const;
 if(!Number.isFinite(Number(rows[0].budget_fold_bytes))||Number(rows[0].budget_fold_bytes)*selected.length>PRIVATE_CREDIT_FOLD_BYTES)return{status:'unavailable',reason:'credit-fold-byte-cap'} as const;
 const invoices=Number(rows[0].budget_rows)===0?[]:rows;
 let units=invoices.length;const positions=new Set<unknown>();for(const row of invoices){if(positions.has(row.position))return{status:'unavailable',reason:'credit-order-ambiguous'} as const;positions.add(row.position);if(!row.voided){if(!Array.isArray(row.allocations))return{status:'unavailable',reason:'credit-allocation-shape'} as const;units+=row.allocations.length;}}
 if(units*selected.length>PRIVATE_CREDIT_FOLD_UNITS)return{status:'unavailable',reason:'credit-fold-cap'} as const;
 const credit=memberCredit({payments,invoices} as unknown as GymState,member,branch);
 if(!Number.isFinite(credit))return{status:'unavailable',reason:'credit-nonfinite'} as const;
 return{status:'ok',credit} as const;
}
