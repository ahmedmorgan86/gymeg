import {commercialEnabled,commercialContext} from './commercial';
import {trialClosed,CommercialError,type License} from './licensing';
import {readEntitySpace} from './entity-store';
import {db} from './database';
import {isFirebaseConfigured,firestoreReadSpace,firestoreCachedSpace} from './firestore-db.ts';
import {cookies} from 'next/headers';
import {getChatGPTUser} from '../chatgpt-auth';
import {emptyState,type GymState} from './domain';
import {normalize} from './extensions';
import {fullAdministration,type Role} from './access';
import {staffMembership} from './firestore-team';
import {sliceBackend} from './workspace-reads';
import {packetQueries} from './workspace-packet';
import {readSlice,readMemberSlice,type Collection,type SliceQuery} from './workspace-slice';
export async function context(allowClosedTrial=false){const user=await getChatGPTUser();if(!user)return null;const gym=(await cookies()).get('gymos-space')?.value;if(commercialEnabled()){const club=await commercialContext(user,gym,(await cookies()).get('gymos-support')?.value);if(!club.support&&!club.platformOwnerAccess&&!allowClosedTrial&&trialClosed(club.license))throw new CommercialError('trialExpired',403);return{user,owner:club.storage_key,tenantId:club.id,license:club.license,role:club.role,branches:club.branches,support:club.support,platformOwnerAccess:club.platformOwnerAccess};}if(!gym||gym===user.userId)return{user,owner:user.userId,tenantId:user.userId,license:null as License|null,role:'owner' as Role,branches:null as string[]|null,support:undefined};const membership=isFirebaseConfigured()?await staffMembership(gym,user.userId):await db.prepare('SELECT role,branches FROM gym_access WHERE owner_id=? AND user_id=? AND revoked=0').bind(gym,user.userId).first<{role:Role;branches:string}>(gym);if(!membership)throw new Error('forbidden');return{user,owner:gym,tenantId:gym,license:null as License|null,role:membership.role as Role,branches:Array.isArray(membership.branches)?membership.branches:JSON.parse(membership.branches) as string[],support:undefined};}
export async function administrator(ctx:NonNullable<Awaited<ReturnType<typeof context>>>){const space=await readSpaceMeta(ctx.owner);return fullAdministration(ctx.role,ctx.branches,space.state.branches.map(b=>b.id));}
/** Revision only (one row/document). Falls back to the full read for a club without entity storage. */
export async function readRevision(owner:string){const r=await sliceBackend().revision(owner);if(r!==null)return r;return (await readSpace(owner)).revision;}
/** Settings, branches, and revision with no entity collections (every collection is empty). */
export async function readSpaceMeta(owner:string){return (await readSpaceSlice(owner,null)) as {state:GymState;revision:number};}
/** Only the requested collections; falls back to the full read on legacy layout, so callers must not rely on other collections being empty. */
export async function readSpaceSlice(owner:string,query:SliceQuery|null){const sliced=await readSlice(sliceBackend(),owner,query,normalize);if(sliced)return{state:sliced.state,revision:sliced.revision};return readSpace(owner);}
/** What the member portal view needs for one member (see readMemberSlice); full read on legacy layout. */
export async function readMemberSpace(owner:string,memberId:string,branch:string){const sliced=await readMemberSlice(sliceBackend(),owner,memberId,branch,normalize);if(sliced)return{state:sliced.state,revision:sliced.revision};return readSpace(owner);}
/**
 * What GET /api/workspace needs: only the collections packet() will ship to this
 * caller (their branches, their role), never events/receipts, and photo versions
 * instead of photo bytes. Same packet as the full read; falls back to it for
 * legacy layouts. Returns the photo versions to pass to packet().
 */
export async function readSpaceForPacket(owner:string,ctx:Pick<Context,'role'|'branches'|'user'>){
  if(isFirebaseConfigured()){const revision=await readRevision(owner);const hit=firestoreCachedSpace(owner,revision);if(hit)return{current:{state:hit,revision},photoVersions:undefined};}
  const be=sliceBackend();
  const [sliced,photoVersions]=await Promise.all([readSlice(be,owner,m=>packetQueries(ctx,(m.settings??{}) as GymState['settings']),normalize),be.photoVersions(owner)]);
  if(!sliced)return{current:await readSpace(owner),photoVersions:undefined};
  return{current:{state:sliced.state,revision:sliced.revision},photoVersions};
}
export type {Collection,SliceQuery};
export type Context=NonNullable<Awaited<ReturnType<typeof context>>>;
export async function readSpace(owner:string){if(isFirebaseConfigured()){return firestoreReadSpace(owner);}let row=await db.prepare('SELECT payload,revision FROM gym_states WHERE user_id=?').bind(owner).first<{payload:string;revision:number}>(owner);if(!row){const state=emptyState();await db.prepare('INSERT OR IGNORE INTO gym_states(user_id,payload,revision,updated_at) VALUES(?,?,0,?)').bind(owner,JSON.stringify(state),new Date().toISOString()).run(owner);row=await db.prepare('SELECT payload,revision FROM gym_states WHERE user_id=?').bind(owner).first<{payload:string;revision:number}>(owner);}if(!row)throw Error('unavailable');if(JSON.parse(row.payload)._entityStorage===1){const stored=await readEntitySpace(owner);return{state:normalize(stored.state),revision:stored.revision};}return{state:normalize(JSON.parse(row.payload) as GymState),revision:row.revision};}
export {packet} from './workspace-packet';
export const reply=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer'}});
export {sameOrigin,requestClientIp} from './request-origin';
export async function hash(text:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(b=>b.toString(16).padStart(2,'0')).join('');}
