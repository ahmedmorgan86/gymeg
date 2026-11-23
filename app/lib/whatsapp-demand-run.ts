// Held bounded enumeration. One page/rule/run; cursor + outbox batch commit
// together. Missing migrations/odd data/races defer, never enumerate full state.
import {createHash} from 'node:crypto';
import type {Scope} from './member-console-source.ts';
import {readWhatsAppJobPage,type WhatsAppCursor} from './whatsapp-job-page.ts';
import type {WhatsAppRule} from './whatsapp.ts';
import {deadlineScope,remaining,WhatsAppDeferred} from './deadline-scope.ts';
export {deadlineScope,remaining,WhatsAppDeferred} from './deadline-scope.ts';
export async function enqueueWhatsAppPage(scope:Scope,q:{owner:string;rule:WhatsAppRule;now:string;deadline:number}){
 const bounded=deadlineScope(scope,q.deadline);
 return bounded(q.owner,async c=>{
  if(!(await c.query("SELECT to_regclass('gymos.whatsapp_scan_cursor') IS NOT NULL AS ok")).rows.some(r=>(r as {ok:boolean}).ok))throw new WhatsAppDeferred('cursor-migration');
  const lock=(await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS ok',['wa-scan:'+q.owner+':'+q.rule.id])).rows[0] as {ok:boolean};
  if(!lock.ok)throw new WhatsAppDeferred('scan-busy');
  const previous=(await c.query('SELECT cursor FROM gymos.whatsapp_scan_cursor WHERE owner_id=$1 AND rule_id=$2',[q.owner,q.rule.id])).rows[0] as {cursor:WhatsAppCursor|null}|undefined;
  const page=await readWhatsAppJobPage((owner,work)=>work(c),{owner:q.owner,rule:q.rule,now:q.now,after:previous?.cursor??undefined});
  if(page.status!=='ok')throw new WhatsAppDeferred(page.reason);
  remaining(q.deadline);
  const jobs=page.jobs.map(job=>({id:createHash('sha256').update(JSON.stringify([q.owner,q.rule.id,job.member,job.occurrence])).digest('hex'),member:job.member,occurrence:job.occurrence,payload:{to:job.to,rule:q.rule,parameters:job.parameters}}));
  if(jobs.length)await c.query("INSERT INTO gymos.whatsapp_outbox(owner_id,id,branch,member_id,rule_id,occurrence,status,payload) SELECT $1,j.id,$2,j.member,$3,j.occurrence,'pending',j.payload FROM jsonb_to_recordset($4::jsonb) AS j(id text,member text,occurrence text,payload jsonb) ON CONFLICT DO NOTHING",[q.owner,q.rule.branch,q.rule.id,JSON.stringify(jobs)]);
  // Deadline throws before cursor advancement and rolls the batch back too.
  remaining(q.deadline);
  await c.query('INSERT INTO gymos.whatsapp_scan_cursor(owner_id,rule_id,cursor,updated_at) VALUES($1,$2,$3,now()) ON CONFLICT(owner_id,rule_id) DO UPDATE SET cursor=excluded.cursor,updated_at=excluded.updated_at',[q.owner,q.rule.id,page.next?JSON.stringify(page.next):null]);
  return{queued:jobs.length,more:page.next!==null};
 });
}
