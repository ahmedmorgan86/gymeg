import {photoWebpEnabled} from './photo-data-url.ts';
import {decodedPhotoKind} from './photo-decode.ts';
/** SERVER ONLY. Admission wiring for the flag-gated WebP photo format. With NEXT_PUBLIC_PHOTO_WEBP unset (default) every function
 * here returns true immediately and the legacy JPEG-only validators are the whole story.
 * With the flag on, ONLY the typed photo slots are inspected, never arbitrary JSON text:
 *   member photo   op member.save / member.photo .photo, state members[].photo, v3 photo entries      (96000 chars, side 320)
 *   product photo  op shop.product.save .photo, state products[].photo                                 (90000 chars, side 1024)
 *   club design    op design.save .design.{backgroundImage,memberImage}, state settings.design.*       (300000 chars, side 2048)
 * A slot value that starts with data:image/webp must (1) fit that slot's char cap (cheap length check, no decode), then (2) pass the
 * full sharp decode. Other strings (JPEG, null, club names that merely start with the same text) are left to the synchronous validators.
 * Work is budgeted per admission: identical values decode once (dedup), every decode is charged side*side pixels worst case, and the
 * budget is shared by everything one admission touches (one operation, or a whole v2/v3 restore including every photo page). */
export type PhotoBudget={decodes:number;pixels:number;seen:Set<string>;deadline?:number};
const OP_DECODES=3,OP_PIXELS=3*2048*2048;
const MEMBER={max:96_000,side:320},PRODUCT={max:90_000,side:1024},CLUB={max:300_000,side:2048};
const MAX_ROWS=50_000;
const obj=(v:unknown):Record<string,unknown>|null=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;
export const operationBudget=(deadline?:number):PhotoBudget=>({decodes:OP_DECODES,pixels:OP_PIXELS,seen:new Set(),deadline});
/** Restore budget DERIVED FROM THE CONTENT being restored, not a constant: each member row can own at most one portrait (320x320),
 * each product one image (1024x1024), plus the two club design images (2048x2048). Distinct values only (dedup), so the work is
 * bounded by the restored club's own size. Measured cost (synthetic, 2 cores): about 5.7 ms per 320px photo, so about 57 s for
 * 10,000 distinct photos. That is why a restore decodes BEFORE its transaction opens, never while holding restore locks. */
export function restoreBudgetFor(state:unknown,deadline?:number):PhotoBudget{
 const s=obj(state),count=(k:string)=>{const r=s?.[k];return Array.isArray(r)?Math.min(r.length,MAX_ROWS+1):0;};
 const m=count('members'),p=count('products');
 return{decodes:m+p+2,pixels:m*MEMBER.side**2+p*PRODUCT.side**2+2*CLUB.side**2,seen:new Set(),deadline};
}
/** Thrown when admission cannot take the work now (queue full, waited too long, or the work deadline passed). Routes answer 503 "busy",
 * never a 400 "invalid": the content was not judged, the client may retry. */
export class DecodeBusy extends Error{reason:'queue'|'wait'|'deadline'|'aborted';constructor(reason:'queue'|'wait'|'deadline'|'aborted'){super('busy:'+reason);this.reason=reason;}}
/** Bounded admission, per server process: ONE decode job runs at a time, at most MAX_WAITING more may wait, a waiter gives up after
 * WAIT_MS and is dropped from the queue (its captured state is released), and a running job must finish inside WORK_MS: the deadline is
 * checked before every decode and a job past it stops with DecodeBusy (a single sharp call is not interruptible, so the overrun is at
 * most one decode of one photo). Defaults sit well inside the restore route's 300 s runtime. Process-local only: other server
 * processes have their own gate, so total CPU is bounded per process, not per deployment. */
export const decodeLimits={maxWaiting:2,waitMs:15_000,workMs:120_000};
let running=false;const waiters:Array<{go:()=>void;drop:()=>void}>=[];
export const decodeGateStats=()=>({running,waiting:waiters.length});
function release(){const n=waiters.shift();if(n)n.go();else running=false;}
export async function withDecodeGate<T>(work:(deadline:number)=>Promise<T>,signal?:AbortSignal):Promise<T>{
 if(signal?.aborted)throw new DecodeBusy('aborted');
 if(running){
  if(waiters.length>=decodeLimits.maxWaiting)throw new DecodeBusy('queue');
  await new Promise<void>((resolve,reject)=>{
   const leave=()=>{clearTimeout(t);signal?.removeEventListener('abort',onAbort);};
   const w={go:()=>{leave();resolve();},drop:()=>{}};
   const out=(why:'wait'|'aborted')=>{const i=waiters.indexOf(w);if(i>=0){waiters.splice(i,1);leave();reject(new DecodeBusy(why));}};
   const onAbort=()=>out('aborted');
   const t=setTimeout(()=>out('wait'),decodeLimits.waitMs);
   signal?.addEventListener('abort',onAbort,{once:true});
   waiters.push(w);
  });
 }else running=true;
 try{
  const deadline=Date.now()+decodeLimits.workMs;
  const result=await work(deadline);
  // The decode itself is not interruptible, so re-check AFTER it: finishing late or after an abort never authorises a write.
  if(Date.now()>deadline)throw new DecodeBusy('deadline');
  if(signal?.aborted)throw new DecodeBusy('aborted');
  return result;
 }finally{release();}
}
const isWebp=(v:unknown)=>typeof v==='string'&&v.startsWith('data:image/webp');
/** Cheap scan (no decode, no gate): does a state carry ANY typed photo slot holding a WebP data URL? Zero-WebP work (names, JPEG, null)
 * never enters the decode gate, so it cannot get a busy 503 because of someone else's restore. */
export function stateHasWebp(state:unknown):boolean{
 const s=obj(state);if(!s)return false;
 for(const k of ['members','products']){const rows=s[k];if(Array.isArray(rows)&&rows.some(r=>isWebp(obj(r)?.photo)))return true;}
 return designSlots(obj(s.settings)?.design).some(x=>isWebp(x.value));
}
export function operationHasWebp(op:Record<string,unknown>):boolean{
 switch(op.type){
  case'member.save':case'member.photo':case'member.register':case'member.details':case'shop.product.save':return isWebp(op.photo);
  case'design.save':return designSlots(op.design).some(x=>isWebp(x.value));
  default:return false;
 }
}
/** Request-level clock for multi-step admission (page reads, dedup, JPEG-only work, decode): throws once the total budget
 * (queue wait + work) is spent or the request was aborted. Call it after awaited work and right before any mutation or BEGIN. */
export function requestClock(signal?:AbortSignal){
 const end=Date.now()+decodeLimits.waitMs+decodeLimits.workMs;
 return()=>{if(signal?.aborted)throw new DecodeBusy('aborted');if(Date.now()>end)throw new DecodeBusy('deadline');};
}
/** Every operation type whose payload carries a photo slot. A test scans domain.ts and shop.ts and fails if a case that handles a
 * photo or design image is missing here, so a new photo-bearing operation cannot silently skip the decode gate. */
export const PHOTO_OPERATION_TYPES=['member.save','member.photo','member.register','member.details','shop.product.save','design.save'] as const;
type Slot={value:unknown;max:number;side:number};
async function admit(slots:Slot[],budget:PhotoBudget){
 if(!photoWebpEnabled())return true;
 for(const s of slots){
  const v=s.value;
  if(typeof v!=='string'||!v.startsWith('data:image/webp'))continue;
  if(v.length>s.max)return false;
  if(budget.seen.has(v))continue;
  if(budget.decodes<=0||budget.pixels<s.side*s.side)return false;
  if(budget.deadline!==undefined&&Date.now()>budget.deadline)throw new DecodeBusy('deadline');
  budget.decodes--;budget.pixels-=s.side*s.side;
  if(await decodedPhotoKind(v,s.max,s.side)!=='webp')return false;
  budget.seen.add(v);
 }
 return true;
}
function designSlots(design:unknown):Slot[]{const d=obj(design);return d?[{value:d.backgroundImage,...CLUB},{value:d.memberImage,...CLUB}]:[];}
/** One workspace operation: only the photo slot of the operation types that carry one. Every other operation costs nothing. */
export async function webpOperationOk(operation:unknown,budget?:PhotoBudget,signal?:AbortSignal){
 if(!photoWebpEnabled())return true;
 const op=obj(operation);if(!op||!PHOTO_OPERATION_TYPES.includes(op.type as never)||!operationHasWebp(op))return true;
 // Ordinary photo writers share the same bounded gate as restores, so one process never runs more than one admission decode job.
 return withDecodeGate(d=>webpOperationBody(op,budget??operationBudget(d)),signal);
}
async function webpOperationBody(op:Record<string,unknown>,budget:PhotoBudget){
 switch(op.type){
  case'member.save':case'member.photo':case'member.register':case'member.details':return admit([{value:op.photo,...MEMBER}],budget);
  case'shop.product.save':return admit([{value:op.photo,...PRODUCT}],budget);
  case'design.save':return admit(designSlots(op.design),budget);
  default:return true;
 }
}
/** A whole state (v2 backup state or v3 core): member and product photo slots plus the club design images. */
export async function webpStateOk(state:unknown,budget:PhotoBudget){
 if(!photoWebpEnabled())return true;
 const s=obj(state);if(!s)return true;
 const slots:Slot[]=[];
 for(const [key,spec] of [['members',MEMBER],['products',PRODUCT]] as const){
  const rows=s[key];if(!Array.isArray(rows))continue;
  if(rows.length>MAX_ROWS)return false;
  for(const r of rows){const row=obj(r);if(row)slots.push({value:row.photo,...spec});}
 }
 slots.push(...designSlots(obj(s.settings)?.design));
 return admit(slots,budget);
}
/** One v3 photo page entry (member portrait). Pass the SAME budget for every entry of a restore. */
export async function webpPhotoEntryOk(content:unknown,budget:PhotoBudget){return admit([{value:content,...MEMBER}],budget);}
