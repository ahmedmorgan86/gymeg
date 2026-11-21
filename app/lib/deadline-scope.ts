import type {Scope} from './member-console-source.ts';
export class WhatsAppDeferred extends Error{reason:string;constructor(reason:string){super(reason);this.reason=reason;}}
export function remaining(deadline:number){const ms=Math.floor(deadline-Date.now());if(ms<1)throw new WhatsAppDeferred('deadline');return ms;}
export function deadlineScope(scope:Scope,deadline:number):Scope{return(owner,work)=>scope(owner,c=>work({query:async(sql,values)=>{
 const ms=Math.min(2000,remaining(deadline));
 // Ignore callers' attempt to increase the per-statement cap. Every real read
 // gets a fresh remaining-budget timeout immediately before it starts.
 if(sql.startsWith("SELECT set_config('statement_timeout'"))return{rows:[]};
 await c.query("SELECT set_config('statement_timeout',$1,true)",[String(ms)]);
 remaining(deadline);return c.query(sql,values);
}}));}
