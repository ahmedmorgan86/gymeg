// Member-credit payment-reference lookup on the shared allocation refs (held, flag-less helper: nothing calls it until the executor's own-account contract is reviewed).
// Legacy: paymentAvailable subtracts allocations that name the payment from ANY non-voided owner invoice, including a foreign branch or member. This returns exactly those invoices' relevant
// allocations (in legacy order: invoice position, then id; allocations in their original order), as `{voided, allocations}` slices that the UNCHANGED legacy memberCredit consumes, so the JS arithmetic, raw/missing/null minor
// values and the voided truthiness are the legacy ones. Anything the refs cannot represent exactly is refused, never approximated.
import {createHash} from 'node:crypto';
import {readOwnerVersion} from './member-summary-store.ts';
// JUDGMENT numbers, not derived: at most 500 distinct payment ids per call (caller falls back to the exact path above it); the 7 maintenance triggers of migration 030000.
export const MAX_CREDIT_PAYMENT_IDS=500;const EXPECTED_TRIGGERS=7;
export type RefsSlice={voided:unknown;allocations:{payment:string;minor?:unknown}[]};
export type RefsCredit={status:'ok';version:string;invoices:RefsSlice[]}|{status:'unavailable';reason:'refs-not-ready'|'unsupported-allocation-shape'|'payment-id'|'refs-drift'|'non-numeric-minor'|'too-many-payment-ids'|'ambiguous-order'|'refs-triggers-disabled'|'no-version'|'changed'};
type Q={query:(sql:string,v?:unknown[])=>Promise<{rows:unknown[]}>};
// `c` must be the caller's scoped connection. Every probe below runs on it; the owner version is read before and after, and the result is only returned when the version is unchanged (and equals opts.ver when the caller already holds one),
// so a concurrent write cannot mix the ready/odd/refs/invoice reads. Foreign-invoice slices are returned only to be folded into a private scalar by the caller: never expose them to the browser or append them to portal hydration.
export async function allocatingInvoicesFromRefs(c:Q,owner:string,paymentIds:unknown[],opts:{ver?:string}={}):Promise<RefsCredit>{
  const ver=await readOwnerVersion(c as never,owner);if(ver===null)return{status:'unavailable',reason:'no-version'};
  if(opts.ver!==undefined&&opts.ver!==ver)return{status:'unavailable',reason:'changed'};
  const r=await inner(c,owner,paymentIds,ver);if(r.status!=='ok')return r;
  if((await readOwnerVersion(c as never,owner))!==ver)return{status:'unavailable',reason:'changed'};
  return r;
}
async function inner(c:Q,owner:string,paymentIds:unknown[],version:string):Promise<RefsCredit>{
  if(!paymentIds.length)return{status:'ok',version,invoices:[]};
  for(const id of paymentIds)if(typeof id!=='string')return{status:'unavailable',reason:'payment-id'};
  const ids=[...new Set(paymentIds as string[])];if(ids.length>MAX_CREDIT_PAYMENT_IDS)return{status:'unavailable',reason:'too-many-payment-ids'};
  // bypass guard: the refs are only exact for origin-role writes while every maintenance trigger is enabled. A disabled trigger or a replica-role session refuses (a replica-role session cannot be trusted to have fired them).
  // This cannot detect a disable/write/re-enable sequence or an earlier replica-role import: those are EXCLUDED while readers are live (see the migration's SUPPORTED CONTRACT note and docs/refs-restore-runbook.md).
  const trg=(await c.query(`SELECT count(*)::int AS n,count(*) FILTER (WHERE tgenabled='O')::int AS ok,current_setting('session_replication_role')='origin' AS origin FROM pg_trigger WHERE tgrelid IN ('gymos.gym_entities'::regclass,'gymos.gym_states'::regclass) AND tgname LIKE 'invoice\\_allocation\\_refs\\_%' AND NOT tgisinternal`)).rows[0] as {n:number;ok:number;origin:boolean};
  if(trg.n!==EXPECTED_TRIGGERS||trg.ok!==EXPECTED_TRIGGERS||!trg.origin)return{status:'unavailable',reason:'refs-triggers-disabled'};
  const ready=(await c.query(`SELECT (EXISTS(SELECT 1 FROM gymos.invoice_allocation_refs_state WHERE owner_id=$1 AND ready) OR (NOT EXISTS(SELECT 1 FROM gymos.invoice_allocation_refs_state WHERE owner_id=$1) AND NOT EXISTS(SELECT 1 FROM gymos.gym_entities WHERE owner_id=$1 AND collection='invoices'))) AS x`,[owner])).rows[0] as {x:boolean};
  if(!ready.x)return{status:'unavailable',reason:'refs-not-ready'};
  // any odd-shape invoice of the owner (every branch: the legacy ledger scans all invoices) makes the legacy filter throw or ignore an element: refuse (voided odd invoices too, conservatively)
  const odd=(await c.query(`SELECT EXISTS(SELECT 1 FROM gymos.invoice_allocation_odd WHERE owner_id=$1) AS x`,[owner])).rows[0] as {x:boolean};
  if(odd.x)return{status:'unavailable',reason:'unsupported-allocation-shape'};
  const els=(await c.query(`SELECT invoice_id,invoice_position,ord,payment_id,has_minor,minor FROM gymos.invoice_allocation_refs WHERE owner_id=$1 AND payment_key=ANY($2::text[]) AND payment_id=ANY($3::text[]) ORDER BY invoice_position,invoice_id,ord`,[owner,ids.map(id=>createHash('md5').update(id).digest('hex')),ids])).rows as {invoice_id:string;invoice_position:number;ord:number;payment_id:string;has_minor:boolean;minor:unknown}[];
  if(!els.length)return{status:'ok',version,invoices:[]};
  // The legacy sum is `sum + invoice.allocations.filter(...).reduce((n,a)=>n+a.minor,0)` over EVERY non-voided invoice. With a string/array/object minor the partial sum becomes a string and each non-matching invoice then appends
  // "0" (concatenation), so the result depends on invoices the lookup does not return: not representable, refuse. number/null/boolean/missing stay numeric, where the non-matching invoices add exactly 0.
  for(const e of els)if(e.has_minor&&e.minor!==null&&(typeof e.minor==='string'||typeof e.minor==='object'))return{status:'unavailable',reason:'non-numeric-minor'};
  const invIds=[...new Set(els.map(e=>e.invoice_id))];
  const inv=new Map<string,{voided:unknown;position:number}>();
  for(const i of (await c.query(`SELECT entity_id,position,payload->'voided' AS voided FROM gymos.gym_entities WHERE owner_id=$1 AND collection='invoices' AND entity_id=ANY($2::text[])`,[owner,invIds])).rows as {entity_id:string;position:number;voided:unknown}[])inv.set(i.entity_id,{voided:i.voided,position:Number(i.position)});
  for(const e of els){const s=inv.get(e.invoice_id);if(!s||s.position!==Number(e.invoice_position))return{status:'unavailable',reason:'refs-drift'};}
  const groups=new Map<string,{pos:number;id:string;allocations:RefsSlice['allocations']}>();
  for(const e of els){let g=groups.get(e.invoice_id);if(!g)groups.set(e.invoice_id,g={pos:Number(e.invoice_position),id:e.invoice_id,allocations:[]});g.allocations.push({payment:e.payment_id,...(e.has_minor?{minor:e.minor}:{})});}
  const invoices=[...groups.values()].sort((a,b)=>a.pos-b.pos||(a.id<b.id?-1:a.id>b.id?1:0)).map(g=>({__id:g.id,voided:inv.get(g.id)!.voided,allocations:g.allocations}));
  // legacy fold order is the array order of state.invoices (loaded ORDER BY collection,position with ties in physical order). Two returned invoices at the same position have no defined legacy order: refuse rather than pick one.
  for(let i=1;i<invoices.length;i++)if(groups.get(invoices[i].__id)!.pos===groups.get(invoices[i-1].__id)!.pos)return{status:'unavailable',reason:'ambiguous-order'};
  return{status:'ok',version,invoices:invoices.map(({voided,allocations})=>({voided,allocations}))};
}
