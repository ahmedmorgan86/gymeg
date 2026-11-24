// HELD source-only orchestration. No database, credentials, network or scheduler.
// Adapter checks must be backed by restricted, atomic database operations before use.
export const message=Object.freeze({title:'GymEG Support',body:'في طلب جديد محتاج مراجعتك / A new request needs your review',url:'/platform'});
const kinds=new Set(['quote_requested','transfer_submitted']);
const id=x=>typeof x==='string'&&x.length>0&&x.length<=200;
export function eventEnvelope(e,owner){
 if(!e||!kinds.has(e.eventKind)||!id(e.orderId)||e.recipientUserId!==owner||!id(e.leaseId)||!Number.isSafeInteger(e.claimSeq)||e.claimSeq<1)throw Error('invalid owner event claim');
 if(Object.keys(e).some(k=>!['eventKind','orderId','recipientUserId','leaseId','claimSeq'].includes(k)))throw Error('unexpected event claim data');
 return Object.freeze({...e});
}
/** No external integration supplied here. At least once, never exactly once.
 * lease and recipient revocation after pre-send check cannot retract in-flight delivery.
 * claim snapshots recipients once. Reclaim must preserve that original snapshot.
 * send returns accepted, invalid, retry or unknown. Exceptions are unknown, never success.
 * Every finish is compare-and-set fenced by event lease and recipient identity.
 */
export async function runBatch(adapter,{owner,maxEvents=20}={}){
 if(!id(owner)||!Number.isInteger(maxEvents)||maxEvents<1||maxEvents>100)throw Error('invalid bounded sender scope');
 const events=await adapter.claim({owner,limit:maxEvents});
 if(!Array.isArray(events)||events.length>maxEvents)throw Error('claim limit violated');
 const claims=events.map(e=>eventEnvelope(e,owner)); // validate entire batch before any send
 if(new Set(claims.map(e=>JSON.stringify([e.orderId,e.eventKind]))).size!==claims.length)throw Error('duplicate event claim');
 const counts={events:claims.length,accepted:0,invalid:0,retry:0,unknown:0,skipped:0,fenced:0,noRecipients:0};
 for(const e of claims){
  const recipients=await adapter.snapshotRecipients(e);
  if(!Array.isArray(recipients)||recipients.length>100)throw Error('invalid bounded recipient snapshot');
  if(recipients.some(r=>!r||!id(r.recipientKey)||r.userId!==owner||Object.keys(r).some(k=>!['recipientKey','userId'].includes(k))))throw Error('invalid owner recipient snapshot');
  if(new Set(recipients.map(r=>r.recipientKey)).size!==recipients.length)throw Error('duplicate recipient snapshot');
  if(!recipients.length){if(await adapter.finishEmpty(e))counts.noRecipients++;else counts.fenced++;continue;}
  for(const r of recipients){
   const gate=await adapter.preSend(e,r);
   if(gate==='stale'){counts.fenced++;break;}
   if(gate==='ineligible'){if(await adapter.finishRecipient(e,r,'skipped'))counts.skipped++;else{counts.fenced++;break;}continue;}
   if(gate!=='eligible')throw Error('invalid pre-send decision');
   let outcome;
   try{outcome=await adapter.send(e,r,message);}catch{outcome='unknown';}
   let retryAt; if(outcome&&typeof outcome==='object'&&outcome.status==='retry'&&Object.keys(outcome).every(k=>['status','retryAt'].includes(k))&&typeof outcome.retryAt==='string'&&Number.isFinite(Date.parse(outcome.retryAt))){retryAt=outcome.retryAt;outcome='retry';}
   if(!['accepted','invalid','retry','unknown'].includes(outcome))outcome='unknown';
   // Adapter owns token retirement on invalid, bounded retry/backoff and ambiguous
   // send reconciliation. A false fence must not acknowledge or retire a new token.
   if(await adapter.finishRecipient(e,r,outcome,retryAt))counts[outcome]++;else{counts.fenced++;break;}
  }
  if(!await adapter.finalize(e))counts.fenced++; // fenced aggregation only, never blind delivered
 }
 return counts; // no order/user/token IDs, transport errors or credential material
}
