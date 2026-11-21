// Exact, private fallback. No allocation refs or derived readiness invariant.
// The unchanged ledger folds EVERY owner invoice, including non-matching rows:
// dropping those changes JS string/NaN arithmetic on legacy payloads.
import type {GymState} from './domain.ts';
import {memberCredit} from './member-ledger.ts';
type Q={query(sql:string,v?:unknown[]):Promise<{rows:unknown[]}>};
export const PRIVATE_CREDIT_INVOICE_CAP=10000;
export async function exactPrivateCredit(c:Q,owner:string,payments:GymState['payments'],member:string,branch:string){
 if(!payments.some(p=>p.member===member&&p.branch===branch&&p.creditable&&!p.voided))return{status:'ok',credit:0} as const;
 const rows=(await c.query(`SELECT position,payload->'allocations' AS allocations,payload->'voided' AS voided FROM gymos.gym_entities WHERE owner_id=$1 AND collection='invoices' ORDER BY position,entity_id LIMIT ${PRIVATE_CREDIT_INVOICE_CAP+1}`,[owner])).rows;
 if(rows.length>PRIVATE_CREDIT_INVOICE_CAP)return{status:'unavailable',reason:'credit-invoice-cap'} as const;
 const positions=new Set<unknown>();for(const row of rows){const p=(row as {position:unknown}).position;if(positions.has(p))return{status:'unavailable',reason:'credit-order-ambiguous'} as const;positions.add(p);}
 const credit=memberCredit({payments,invoices:rows} as unknown as GymState,member,branch);
 if(!Number.isFinite(credit))return{status:'unavailable',reason:'credit-nonfinite'} as const;
 return{status:'ok',credit} as const;
}
