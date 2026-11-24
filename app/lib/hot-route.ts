import {demandOwnerAllowed} from './demand-owner-scope';
import {applyHot,hotPlan} from './hot-op-plans';
import {readHotSlice,type SliceBackend} from './workspace-slice';
import {persistSpace,SliceConflict} from './entity-store';
import {receptionPermitted} from './access';
import {normalize} from './extensions';
import {RECENT_EVENTS} from './activity-archive';
import type {Operation} from './domain';
/**
 * Default-off hot path for POST /api/workspace. It only ever handles the success case. Any doubt
 * (flag off, non-delta, unplanned op, legacy layout, cap, oversized freezes, trim window, replay,
 * stale revision, permission, rule error, lost revision race) returns null and the caller runs the
 * unchanged full path, which then produces the exact response, error and replay behavior.
 */
export type HotRouteInput={owner:string;userId:string;displayName:string;role:string;branches?:string[]|null;requestId:string;digest:string;revision:number;operation:Operation;deltaMode:boolean};
export const hotOpsEnabled=()=>process.env.GYMOS_HOT_OPS==='1';
export async function tryHotOperation(be:SliceBackend,i:HotRouteInput,now=new Date().toISOString(),newId:()=>string=()=>crypto.randomUUID()):Promise<{revision:number}|null>{
  if(!hotOpsEnabled()||!i.deltaMode||!demandOwnerAllowed(i.owner))return null;
  const plan=hotPlan(i.operation);if(!plan||!be.supportsOpen)return null;
  if(i.branches&&!i.branches.includes(i.operation.branch))return null;
  const receiptId=i.userId+':'+i.requestId;
  let hot,state;
  try{
    if((await be.entities(i.owner,{collections:['receipts'],ids:[receiptId]})).length)return null; // replay: full path answers
    hot=await readHotSlice(be,i.owner,plan,normalize);
    if(!hot||!hot.counts||!hot.positions||hot.revision!==i.revision)return null;
    if(!receptionPermitted(i.role as never,i.operation.type,hot.state.settings.receptionGrants?.[i.userId]))return null;
    state=applyHot(structuredClone(hot.state),hot.counts,i.operation,now,i.displayName,newId);
    state.receipts.push({id:receiptId,digest:i.digest});
  }catch{return null;}
  let ok;try{ok=await persistSpace(i.owner,{state:hot.state,revision:hot.revision},state,false,{positions:hot.positions,trims:[{collection:'events',keep:RECENT_EVENTS},{collection:'receipts',keep:1000}]});}catch(e){if(e instanceof SliceConflict)return null;throw e;}
  return ok?{revision:hot.revision+1}:null;
}
