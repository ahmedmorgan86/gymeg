// HELD operator helper. No route calls this. Caller owns exact selected identity,
// reviewed source/schema/ACL admission, original-row parity and bounded transaction.
import {refreshDirtySummaries} from './member-summary-store.ts';
type Sql={query(sql:string,values?:unknown[]):Promise<{rows:unknown[]}>};
export async function materializeDemandCanary(c:Sql,owner:string,expectedOwner:string,asOf:string){
 if(owner!==expectedOwner||!owner)throw Error('unreviewed canary owner');
 // Never overwrite an existing writer-created token. nextval may leave gaps on rollback.
 await c.query("INSERT INTO gymos.gym_owner_version(owner_id,version) VALUES($1,nextval('gymos.gym_change_seq')) ON CONFLICT(owner_id) DO NOTHING",[owner]);
 const r=await refreshDirtySummaries(c,owner,500,asOf);
 if(r.status!=='ok'||r.remaining!==0)throw Error('canary summaries not fully materialized: '+r.status+(r.status==='ok'?':'+r.remaining:''));
 const version=(await c.query('SELECT version::text version FROM gymos.gym_owner_version WHERE owner_id=$1',[owner])).rows[0] as {version:string}|undefined;
 if(!version)throw Error('canary version missing');return{status:'ok' as const,refreshed:r.refreshed,version:version.version};
}
