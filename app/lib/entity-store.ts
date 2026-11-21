import {syncMemberAccess} from './sync-member-access.ts';
import {RECENT_EVENTS} from './activity-archive.ts';
import {assertGrowth,CommercialError,licenseState,type License} from './licensing.ts';
import {getPool} from './database.ts';
import {assembleState,splitState,entityChanges,type Entity} from './entity-state.ts';
import type {GymState} from './domain';
import {processWorkspaceOutbox} from './realtime-broadcast.ts';
import {readCounters,STATE_BYTE_LIMIT} from './workspace-slice.ts';
import {useFirestorePersistence,firestorePersistSpace,firestoreReadSpace} from './firestore-db.ts';
export async function readEntitySpace(owner:string){if(useFirestorePersistence()){return firestoreReadSpace(owner);}const client=await getPool().connect();try{await client.query('BEGIN');await client.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);const row=(await client.query('SELECT payload,revision FROM gymos.gym_states WHERE user_id=$1 FOR SHARE',[owner])).rows[0] as {payload:string;revision:number};const entities=(await client.query('SELECT collection,entity_id,position,branch,payload FROM gymos.gym_entities WHERE owner_id=$1 ORDER BY collection,position',[owner])).rows as Entity[];const images=(await client.query('SELECT member_id,content FROM gymos.gym_photos WHERE owner_id=$1',[owner])).rows as {member_id:string;content:string}[];const state=assembleState(JSON.parse(row.payload),entities,Object.fromEntries(images.map(p=>[p.member_id,p.content])));await client.query('COMMIT');return{state,revision:row.revision};}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
/**
 * Slice mode (hot operations only). The state passed in is partial, so row positions
 * cannot come from array indexes: existing rows keep the stored position they were
 * loaded with, new rows get max(position)+1 per collection (safe under the state-row
 * FOR UPDATE lock), and bounded collections (events, receipts) drop their oldest rows.
 */
export type SliceMode={positions:Record<string,number>;trims:{collection:string;keep:number}[]};
type Q={query(sql:string,values?:unknown[]):Promise<{rows:unknown[];rowCount?:number|null}>};
/** A row the slice treats as new already exists in storage but was not loaded: positions would be wrong, so refuse the write (rolled back) and let the caller run the full path. */
export class SliceConflict extends Error{constructor(message='slice: existing row absent from loaded positions'){super(message);}}
/** The proposed slice write cannot be proven to keep the full state within the callers' byte rule: refuse (rolled back) and let the exact full path decide. */
export class SliceTooLarge extends SliceConflict{constructor(){super('slice: size not proven within the full-state byte rule');}}
const utf8=(v:unknown)=>new TextEncoder().encode(JSON.stringify(v)).byteLength;
/** Conservative growth of JSON.stringify(full state) caused by a slice write: every upserted payload at its full size (the replaced row is not credited), the positive metadata change, and added or changed photos. */
export function sliceGrowthBound(upserts:Entity[],beforeMeta:unknown,afterMeta:unknown,photos:string[]){let g=0;for(const u of upserts)g+=utf8(u.payload)+1;g+=Math.max(0,utf8(afterMeta)-utf8(beforeMeta));for(const p of photos)g+=utf8(p)+9;return g;}
export async function sliceUpserts(client:Q,owner:string,upserts:Entity[],slice:SliceMode):Promise<Entity[]>{
  const key=(e:{collection:string;entity_id:string})=>e.collection+':'+e.entity_id;
  const fresh=upserts.filter(e=>slice.positions[key(e)]===undefined);
  const max:Record<string,number>={};
  if(fresh.length){const hit=await client.query('SELECT 1 FROM gymos.gym_entities e JOIN jsonb_to_recordset($2::jsonb) AS x(collection text,entity_id text) ON e.collection=x.collection AND e.entity_id=x.entity_id WHERE e.owner_id=$1 LIMIT 1',[owner,JSON.stringify(fresh.map(e=>({collection:e.collection,entity_id:e.entity_id})))]);if(hit.rows.length)throw new SliceConflict();for(const c of new Set(fresh.map(e=>e.collection))){const r=(await client.query('SELECT position::int AS p FROM gymos.gym_entities WHERE owner_id=$1 AND collection=$2 ORDER BY position DESC LIMIT 1',[owner,c])).rows[0] as {p:number}|undefined;if(r)max[c]=r.p;} // one backward index probe per collection (a GROUP BY max() scanned the whole collection)
  }
  return upserts.map(e=>{const known=slice.positions[key(e)];if(known!==undefined)return{...e,position:known};max[e.collection]=(max[e.collection]??-1)+1;return{...e,position:max[e.collection]};});
}
export async function sliceTrims(client:Q,owner:string,slice:SliceMode):Promise<Entity[]>{
  const gone:Entity[]=[];
  for(const t of slice.trims){
    const rows=(await client.query('DELETE FROM gymos.gym_entities WHERE owner_id=$1 AND collection=$2 AND entity_id IN (SELECT entity_id FROM gymos.gym_entities WHERE owner_id=$1 AND collection=$2 ORDER BY position ASC,entity_id ASC LIMIT GREATEST(0,(SELECT count(*) FROM gymos.gym_entities WHERE owner_id=$1 AND collection=$2)-$3)) RETURNING collection,entity_id',[owner,t.collection,t.keep])).rows as {collection:string;entity_id:string}[];
    gone.push(...rows.map(r=>({collection:r.collection,entity_id:r.entity_id,position:0,branch:null,payload:{}}) as Entity));
  }
  return gone;
}
export async function persistSpace(owner:string,current:{state:GymState;revision:number},next:GymState,restore=false,slice?:SliceMode){if(restore)next={...next,generation:crypto.randomUUID()};if(useFirestorePersistence()){return firestorePersistSpace(owner,current,next,restore);}const client=await getPool().connect();try{await client.query('BEGIN');await client.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);const row=(await client.query('SELECT payload,revision FROM gymos.gym_states WHERE user_id=$1 FOR UPDATE',[owner])).rows[0] as {payload:string;revision:number}|undefined;if(!row||row.revision!==current.revision){await client.query('ROLLBACK');return false;}let tenantId=owner;if(process.env.GYMOS_COMMERCIAL==='1'){const tRow=(await client.query('SELECT id FROM gymos.tenants WHERE storage_key=$1 FOR UPDATE',[owner])).rows[0] as {id:string}|undefined;if(tRow?.id)tenantId=tRow.id;const licenseRow=(await client.query('SELECT l.* FROM gymos.tenant_licenses l JOIN gymos.tenants t ON t.id=l.tenant_id WHERE t.storage_key=$1',[owner])).rows[0] as License|undefined;if(!licenseRow)throw new CommercialError('licenseReadOnly',403);for(const field of ['starts_at','ends_at','maintenance_until'] as const){const value=licenseRow[field] as unknown;if(value instanceof Date)licenseRow[field]=value.toISOString();}if(!licenseState(licenseRow).writable)throw new CommercialError('licenseReadOnly',403);assertGrowth(licenseRow.limits,{branches:current.state.branches.length,members:current.state.members.length},{branches:next.branches.length,members:next.members.length});}const first=JSON.parse(row.payload)._entityStorage!==1;if(first||restore)await client.query('INSERT INTO gymos.gym_recovery(id,owner_id,payload,created_at) VALUES($1,$2,$3,$4)',[crypto.randomUUID(),owner,JSON.stringify(current.state),new Date().toISOString()]);const archived=JSON.parse(row.payload)._activityArchive===1;
 const known=new Set(current.state.events.map(e=>e.id));
 const events=!archived||restore?[...new Map([...current.state.events,...next.events].map(e=>[e.id,e])).values()]:next.events.filter(e=>!known.has(e.id));
 for(let i=0;i<events.length;i+=500){const batch=JSON.stringify(events.slice(i,i+500));const mismatch=await client.query("SELECT 1 FROM gymos.gym_activity_archive a JOIN jsonb_array_elements($2::jsonb) x ON a.event_id=x->>'id' WHERE a.owner_id=$1 AND a.payload<>x LIMIT 1",[owner,batch]);if(mismatch.rowCount)throw new Error('Immutable activity conflict');await client.query("INSERT INTO gymos.gym_activity_archive(owner_id,event_id,branch,at,payload) SELECT $1,x->>'id',x->>'branch',x->>'at',x FROM jsonb_array_elements($2::jsonb) x ON CONFLICT(owner_id,event_id) DO NOTHING",[owner,batch]);}
 const before=splitState(current.state),after=splitState({...next,events:next.events.slice(-RECENT_EVENTS)}),changes=entityChanges(before.entities,after.entities,first),{removed}=changes;let {upserts}=changes;if(slice){upserts=await sliceUpserts(client,owner,upserts,slice);
  // Transactional size proof: counters are exact for this revision (we hold the owner row FOR UPDATE and passed the revision check). Without a ready bound, or with growth that could pass the rule, take the exact full path.
  const k=await readCounters(client as never,owner);if(!k)throw new SliceTooLarge();
  const meta=Number((await client.query('SELECT octet_length(payload) AS n FROM gymos.gym_states WHERE user_id=$1',[owner])).rows[0]?.n??0);
  const changedPhotos=Object.entries(after.photos).filter(([id,c])=>first||before.photos[id]!==c).map(([,c])=>c);
  if(meta+k.bytes+k.rows+4096+sliceGrowthBound(upserts,before.metadata,after.metadata,changedPhotos)>STATE_BYTE_LIMIT)throw new SliceTooLarge();}for(let i=0;i<removed.length;i+=1000)await client.query('DELETE FROM gymos.gym_entities e USING jsonb_to_recordset($2::jsonb) AS x(collection text,entity_id text) WHERE e.owner_id=$1 AND e.collection=x.collection AND e.entity_id=x.entity_id',[owner,JSON.stringify(removed.slice(i,i+1000).map(e=>({collection:e.collection,entity_id:e.entity_id})))]);if(upserts.length)await client.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) SELECT $1,x.collection,x.entity_id,x.position,x.branch,x.payload FROM jsonb_to_recordset($2::jsonb) AS x(collection text,entity_id text,position integer,branch text,payload jsonb) ON CONFLICT(owner_id,collection,entity_id) DO UPDATE SET position=excluded.position,branch=excluded.branch,payload=excluded.payload',[owner,JSON.stringify(upserts)]);if(slice)removed.push(...await sliceTrims(client,owner,slice));for(const [id,content]of Object.entries(after.photos))if(first||before.photos[id]!==content)await client.query('INSERT INTO gymos.gym_photos(owner_id,member_id,content) VALUES($1,$2,$3) ON CONFLICT(owner_id,member_id) DO UPDATE SET content=excluded.content',[owner,id,content]);for(const id of Object.keys(before.photos))if(!(id in after.photos))await client.query('DELETE FROM gymos.gym_photos WHERE owner_id=$1 AND member_id=$2',[owner,id]);after.metadata._activityArchive=1;const newRevision=current.revision+1;await client.query('UPDATE gymos.gym_states SET payload=$1,revision=revision+1,updated_at=$2 WHERE user_id=$3',[JSON.stringify(after.metadata),new Date().toISOString(),owner]);
  try{
    await client.query('SAVEPOINT events_sp');
    const eventsToLog=[...upserts.map(u=>({id:crypto.randomUUID(),event_type:'entity.upsert',collection:u.collection,entity_id:u.entity_id,branch:u.branch??null,payload:u.payload})),...removed.map(r=>({id:crypto.randomUUID(),event_type:'entity.delete',collection:r.collection,entity_id:r.entity_id,branch:null,payload:null})),...(JSON.stringify(before.metadata)!==JSON.stringify(after.metadata)?[{id:crypto.randomUUID(),event_type:'metadata.update',collection:'_metadata',entity_id:'settings',branch:null,payload:after.metadata}]:[])];
    if(eventsToLog.length){
      for(let i=0;i<eventsToLog.length;i+=500){
        const chunk=eventsToLog.slice(i,i+500);
        await client.query('INSERT INTO gymos.workspace_events(id,owner_id,tenant_id,revision,event_type,collection,entity_id,branch,payload) SELECT x.id,$1,$2,$3,x.event_type,x.collection,x.entity_id,x.branch,x.payload FROM jsonb_to_recordset($4::jsonb) AS x(id text,event_type text,collection text,entity_id text,branch text,payload jsonb) ON CONFLICT(owner_id,revision,id) DO NOTHING',[owner,tenantId,newRevision,JSON.stringify(chunk)]);
      }
    }
    await client.query('INSERT INTO gymos.workspace_outbox(id,owner_id,tenant_id,channel,event,payload) VALUES($1,$2,$3,$4,$5,$6)',[crypto.randomUUID(),owner,tenantId,`club:${tenantId}:workspace`,'workspace.updated',JSON.stringify({revision:newRevision,tenantId,timestamp:new Date().toISOString()})]);
    await client.query('RELEASE SAVEPOINT events_sp');
  }catch(eventErr){
    try{await client.query('ROLLBACK TO SAVEPOINT events_sp');}catch{}
    console.warn('[Workspace Events Safe Rollback]:',eventErr);
  }
  if(first||restore||JSON.stringify(current.state.members.map(m=>[m.id,m.branch,m.demo,m.archived,m.phone]))!==JSON.stringify(next.members.map(m=>[m.id,m.branch,m.demo,m.archived,m.phone]))){
    try{
      await client.query('SAVEPOINT member_access_sp');
      await syncMemberAccess(client,next.members);
      await client.query('RELEASE SAVEPOINT member_access_sp');
    }catch(syncErr){
      try{await client.query('ROLLBACK TO SAVEPOINT member_access_sp');}catch{}
      console.warn('[Member Access Sync Safe Rollback]:',syncErr);
    }
  }
  await client.query('COMMIT');
  try{void processWorkspaceOutbox(owner);}catch{}
  return true;
 }catch(error){
  await client.query('ROLLBACK');
  throw error;
 }finally{
  client.release();
 }
}
