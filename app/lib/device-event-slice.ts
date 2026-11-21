// Default-OFF device ingest hydration. Falls back to the exact full mutation
// whenever the existing hot-operation proofs (counts/bytes/history caps) fail.
import {deviceEventSchema,ingestDeviceEvent} from './device-bridge.ts';
import {readSlice,readHotSlice,type SliceBackend} from './workspace-slice.ts';
import {applyHot} from './hot-op-plans.ts';
import {normalize} from './extensions.ts';
import {persistSpace,SliceConflict} from './entity-store.ts';
import {RECENT_EVENTS} from './activity-archive.ts';
export async function tryDeviceSlice(be:SliceBackend,q:{owner:string;branch:string;device:string;input:unknown;now:string;newId:()=>string}){
 if(process.env.GYMOS_DEVICE_EVENT_READS!=='1'||!be.supportsOpen)return null;
 const data=deviceEventSchema.parse(q.input);
 const metadata=await readSlice(be,q.owner,null,normalize);if(!metadata)return null;
 // Reuse the exact duplicate/conflicting-event checks before any mutation.
 if(metadata.state.engagement?.deviceEvents.some(e=>e.id===q.device+':'+data.eventId))return ingestDeviceEvent(metadata.state,q.branch,q.device,data,q.now,q.newId).duplicate;
 const device=metadata.state.engagement?.devices.find(d=>d.id===q.device&&d.branch===q.branch&&d.enabled),mapping=device?.mappings.find(m=>m.person===data.personId);
 if(!mapping)return null;
 const hot=await readHotSlice(be,q.owner,{branch:q.branch,member:mapping.member},normalize);
 if(!hot?.counts||!hot.positions||hot.revision!==metadata.revision)return null;
 const result=ingestDeviceEvent(hot.state,q.branch,q.device,data,q.now,q.newId,(s,op,now,actor,newId)=>applyHot(s,hot.counts!,op,now,actor,newId));
 if(result.duplicate)return true;
 try{const ok=await persistSpace(q.owner,{state:hot.state,revision:hot.revision},result.state,false,{positions:hot.positions,trims:[{collection:'events',keep:RECENT_EVENTS}]});return ok?false:null;}catch(e){if(e instanceof SliceConflict)return null;throw e;}
}
