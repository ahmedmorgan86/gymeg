import {readMemberSlice,type SliceBackend} from './workspace-slice.ts';
import type {Scope} from './member-console-source.ts';
import {readOwnerVersion} from './member-summary-store.ts';
import {readPortalOccupancy} from './member-portal-occupancy.ts';
import {normalize} from './extensions.ts';
import {receptionPolicy} from './member-console.ts';
export async function readMemberPortalSlice(be:SliceBackend,scope:Scope,q:{owner:string;member:string;branch:string;now:string}){
 if(!be.supportsOpen)return null;
 const before=await scope(q.owner,c=>readOwnerVersion(c,q.owner));if(before===null)return null;
 const sliced=await readMemberSlice(be,q.owner,q.member,q.branch,normalize,{skipOccupancy:true});if(!sliced)return null;
 const present=await readPortalOccupancy(scope,{owner:q.owner,branch:q.branch,now:q.now,autoExitMinutes:receptionPolicy(sliced.state).autoExitMinutes});
 if(present.status!=='ok'||present.version!==before)return null;
 if((await scope(q.owner,c=>readOwnerVersion(c,q.owner)))!==before||await be.revision(q.owner)!==sliced.revision)return null;
 return{state:sliced.state,revision:sliced.revision,occupancy:present.occupancy};
}
