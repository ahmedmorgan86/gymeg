// Cost guard shared by the per-day screen reads: a statement timeout inside the owner scope (a timeout aborts the read, the route answers 503 and the screen keeps its legacy
// expression), and a small result cache keyed by the owner change-version read before AND after the work (any writer bumps it), so repeated refetches at one version cost one version read.
import {readOwnerVersion} from './member-summary-store.ts';
type Sql={query(sql:string,values?:unknown[]):Promise<{rows:unknown[]}>};
export const READ_TIMEOUT_MS=2000; // judgment, not derived: well above the measured realistic cost (ms), far below a request budget
const MAX_ENTRIES=500;
const cache=new Map<string,unknown>();
export async function boundedRead<T>(c:Sql,owner:string,key:string,work:()=>Promise<T>):Promise<T>{
  await c.query("SELECT set_config('statement_timeout',$1,true)",[String(READ_TIMEOUT_MS)]);
  const v1=await readOwnerVersion(c,owner),k=v1===null?null:owner+'\u0000'+v1+'\u0000'+key;
  if(k!==null&&cache.has(k))return structuredClone(cache.get(k)) as T;
  const out=await work();
  if(k!==null&&(await readOwnerVersion(c,owner))===v1){if(cache.size>=MAX_ENTRIES)cache.delete(cache.keys().next().value as string);cache.set(k,structuredClone(out));}
  return out;
}
export function clearBoundedReadCache(){cache.clear();}
