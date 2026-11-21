// Held read-only database lifetime, used only by the default-OFF member account API.
// No writer behavior changes. One absolute route clock includes acquisition,
// identity, license and financial reads. It is not a CPU/network response bound.
import {getPool} from './database.ts';
export class ReadDatabaseDeadline extends Error{constructor(){super('read database deadline');this.name='ReadDatabaseDeadline';}}
export class ReadDatabaseBusy extends Error{constructor(){super('read database busy');this.name='ReadDatabaseBusy';}}
type Client={query(sql:string,values?:unknown[]):Promise<{rows:unknown[]}>;release(destroy?:boolean):void};
type Pool={connect():Promise<Client>};
export const MAX_PENDING_READ_ACQUIRES=10; // explicit admission bound, not capacity acceptance
let pending=0;
const msLeft=(deadline:number)=>{const n=Math.floor(deadline-Date.now());if(n<1)throw new ReadDatabaseDeadline();return n;};
function until<T>(promise:Promise<T>,deadline:number,onLate?:(value:T)=>void):Promise<T>{
 return new Promise((resolve,reject)=>{let settled=false;
  const timer=setTimeout(()=>{settled=true;reject(new ReadDatabaseDeadline());},Math.max(0,deadline-Date.now()));
  promise.then(value=>{if(settled){onLate?.(value);return;}settled=true;clearTimeout(timer);resolve(value);},error=>{if(settled)return;settled=true;clearTimeout(timer);reject(error);});
 });
}
export async function readTransaction<T>(pool:Pool,deadline:number,work:(client:Pick<Client,'query'>)=>Promise<T>,owner?:string):Promise<T>{
 msLeft(deadline);if(pending>=MAX_PENDING_READ_ACQUIRES)throw new ReadDatabaseBusy();pending++;
 let client:Client;
 try{
  const connecting=Promise.resolve().then(()=>pool.connect()).then(c=>{pending--;return c;},e=>{pending--;throw e;});
  // An expired queued acquisition can still be delivered by pg later. Release
  // that lease immediately, without BEGIN, scope setup or callback execution.
  client=await until(connecting,deadline,c=>c.release());
 }catch(error){throw error;}
 let destroy=false,transaction=false;
 const raw=(sql:string,values?:unknown[])=>{msLeft(deadline);return until(client.query(sql,values),deadline);};
 const query=async(sql:string,values?:unknown[])=>{
  const timeout=Math.min(2000,msLeft(deadline));
  await raw("SELECT set_config('statement_timeout',$1,true)",[String(timeout)]);
  return raw(sql,values);
 };
 try{
  await raw('BEGIN READ ONLY');transaction=true;
  if(owner!==undefined)await query("SELECT set_config('app.gym_owner',$1,true)",[owner]);
  const out=await until(Promise.resolve().then(()=>work({query})),deadline);
  await raw('COMMIT');transaction=false;return out;
 }catch(error){
  // Never put an expired/unknown transaction back into the pool. Destroying
  // the connection also cancels in-flight SQL instead of hiding late work.
  if(error instanceof ReadDatabaseDeadline||Date.now()>=deadline)destroy=true;
  else if(transaction){try{await raw('ROLLBACK');transaction=false;}catch{destroy=true;}}
  else destroy=true; // failed BEGIN leaves connection state unproved
  throw error;
 }finally{client.release(destroy);}
}
export const withReadTransaction=<T>(deadline:number,work:(client:Pick<Client,'query'>)=>Promise<T>,owner?:string)=>readTransaction(getPool(),deadline,work,owner);
export const readDeadlineScope=(deadline:number)=><T>(owner:string,work:(client:Pick<Client,'query'>)=>Promise<T>)=>withReadTransaction(deadline,work,owner);
