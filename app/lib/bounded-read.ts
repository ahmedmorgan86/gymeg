// Cost guard shared by the per-day screen reads: a statement timeout inside the owner scope (a timeout aborts the read, the route answers 503 and the screen keeps its legacy
// expression), and a small result cache keyed by the owner change-version read before AND after the work (any writer bumps it), so repeated refetches at one version cost one version read.
import {readOwnerVersion} from './member-summary-store.ts';
type Sql={query(sql:string,values?:unknown[]):Promise<{rows:unknown[]}>};
export const READ_TIMEOUT_MS=2000; // judgment, not derived: well above the measured realistic cost (ms), far below a request budget
const MAX_ENTRIES=500;
const cache=new Map<string,unknown>();
/** Thrown instead of the driver's 57014 so the pool wrapper's retry-on-"timeout" text match does not repeat an expensive query. Deliberately carries no "timeout"/"503" text. */
export class ReadBudgetError extends Error{constructor(){super('read budget exceeded');this.name='ReadBudgetError';}}
export function budgetGuard(e:unknown):never{if((e as {code?:string})?.code==='57014')throw new ReadBudgetError();throw e;}
export async function boundedRead<T>(c:Sql,owner:string,key:string,work:()=>Promise<T>):Promise<T>{
  await c.query("SELECT set_config('statement_timeout',$1,true)",[String(READ_TIMEOUT_MS)]);
  const v1=await readOwnerVersion(c,owner),k=v1===null?null:owner+'\u0000'+v1+'\u0000'+key;
  if(k!==null&&cache.has(k))return structuredClone(cache.get(k)) as T;
  let out:T;try{out=await work();}catch(e){return budgetGuard(e);}
  if(k!==null&&(await readOwnerVersion(c,owner))===v1){if(cache.size>=MAX_ENTRIES)cache.delete(cache.keys().next().value as string);cache.set(k,structuredClone(out));}
  return out;
}
export function clearBoundedReadCache(){cache.clear();}
