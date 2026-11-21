import type {SliceBackend} from './workspace-slice';
import {packetQueries} from './workspace-packet';
import type {GymState} from './domain';
/**
 * Bounded, paged per-member history for the profile and account screens (visits, payments, invoices).
 * Newest first, keyed by stored position, so concatenated pages equal the full filtered list reversed.
 * The caller supplies the branch scope it is allowed to see; a member outside it is refused (null),
 * never returned empty, so a scope bug cannot look like "no history". Nothing here is route-wired.
 */
export const HISTORY_COLLECTIONS=['visits','payments','invoices'] as const;
export type HistoryCollection=typeof HISTORY_COLLECTIONS[number];
export const HISTORY_PAGE_MAX=100;
export type HistoryPage={rows:Record<string,unknown>[];/** Pass as `before` for the next page; null when there is no older row. */next:number|null;revision:number};
/** True for the entity layout. A legacy single-payload club has no rows to page, so callers must answer 501, not an empty or 404 result. */
export async function isEntityLayout(be:SliceBackend,owner:string){const m=await be.meta(owner);return !!m&&m.metadata._entityStorage===1;}
export async function readMemberHistory(be:SliceBackend,owner:string,q:{member:string;collection:HistoryCollection;branches?:string[]|null;before?:number;limit?:number}):Promise<HistoryPage|null>{
  if(!HISTORY_COLLECTIONS.includes(q.collection)||!q.member)return null;
  const limit=Math.max(1,Math.min(HISTORY_PAGE_MAX,Math.floor(q.limit??50)));
  if(!await isEntityLayout(be,owner))return null;
  const rev=await be.revision(owner);if(rev===null)return null;
  const [m]=await be.entities(owner,{collections:['members'],ids:[q.member],branches:q.branches??null});
  if(!m)return null;
  const rows=await be.entities(owner,{collections:[q.collection],match:{field:'member',values:[q.member]},desc:true,limit:limit+1,...(q.before!==undefined?{before:q.before}:{})});
  const page=rows.slice(0,limit);
  const after=await be.revision(owner);if(after!==rev)return null; // a write landed between the reads: caller retries or falls back
  return{rows:page.map(r=>r.payload as Record<string,unknown>),next:rows.length>limit?Number(page[page.length-1].position):null,revision:rev};
}

/**
 * Role and branch scope for a history read, taken from the same rules the packet uses (packetQueries):
 * a collection the packet would not ship to this user is refused here, and rows stay inside ctx.branches.
 */
export function historyScope(ctx:{role:string;branches?:string[]|null;user:{userId:string}},settings:GymState['settings'],collection:HistoryCollection):{allowed:boolean;branches:string[]|null}{
  const queries=packetQueries(ctx as never,settings);
  const allowed=queries.some(q=>(q.collections as string[]).includes(collection)&&(!q.branches||!ctx.branches||q.branches.every(b=>ctx.branches!.includes(b))));
  return{allowed,branches:ctx.branches??null};
}
