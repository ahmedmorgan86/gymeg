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
export type HistoryPage={rows:Record<string,unknown>[];/** at-order cursor (visits only): `<at>|<position>` */nextCursor?:string|null;/** Pass as `before` for the next page; null when there is no older row. */next:number|null;revision:number};
/** True for the entity layout. A legacy single-payload club has no rows to page, so callers must answer 501, not an empty or 404 result. */
export async function isEntityLayout(be:SliceBackend,owner:string){const m=await be.meta(owner);return !!m&&m.metadata._entityStorage===1;}
/** Cursor for at-ordered visits: `<encoded at>|<position>`. `at` is encoded because legacy rows may hold any string. */
const encodeCursor=(at:string,position:number)=>`${encodeURIComponent(at)}|${position}`;
function parseCursor(c:string):{at:string;position:number}|null{const m=/^([^|]*)\|(\d{1,12})$/.exec(c);if(!m)return null;try{return{at:decodeURIComponent(m[1]),position:Number(m[2])};}catch{return null;}}
const CANON=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
/** Legacy order: `[...visits].sort((a,b)=>b.at.localeCompare(a.at))` over position-ordered rows. Stable, so equal keys keep ascending position. */
const legacyBefore=(a:{at:string;position:number},b:{at:string;position:number})=>b.at.localeCompare(a.at)||a.position-b.position;
/**
 * Visits in the profile's display order, keyset-paged. Fast path: all of the member's scoped `at` values are canonical, so one indexed
 * code-point-ordered query is exact. Otherwise the member's own visits (never the club's) are sorted with the legacy comparator in memory.
 * null = no exact order exists (no string `at`, or the member's history is too large for the fallback): caller answers 501.
 */
export async function readMemberVisitsByAt(be:SliceBackend,owner:string,q:{member:string;branches?:string[]|null;cursor?:string;limit?:number}):Promise<HistoryPage|null|'race'|'badCursor'|'missing'>{
  if(!q.member)return null;const limit=Math.max(1,Math.min(HISTORY_PAGE_MAX,Math.floor(q.limit??50)));
  let cursor:{at:string;position:number}|undefined;if(q.cursor!==undefined){const c=parseCursor(q.cursor);if(!c)return 'badCursor';cursor=c;}
  if(!await isEntityLayout(be,owner))return null;const rev=await be.revision(owner);if(rev===null)return null;
  const [m]=await be.entities(owner,{collections:['members'],ids:[q.member],branches:q.branches??null});if(!m)return 'missing';
  let rows:{payload:unknown;position:number}[]|null|'irregular'=await be.visitsByAt(owner,{member:q.member,branches:q.branches??null,cursor:cursor&&CANON.test(cursor.at)?cursor:undefined,limit:limit+1});
  if(cursor&&!CANON.test(cursor.at)&&rows!=='irregular'&&rows!==null)return 'race'; // the member's history changed shape between pages: restart
  if(rows==='irregular'){
    let all;try{all=await be.entities(owner,{collections:['visits'],match:{field:'member',values:[q.member]},branches:q.branches??null});}catch{return null;} // too large to sort exactly in memory
    const keyed=all.map(e=>({e,at:(e.payload as {at?:unknown}).at,position:Number(e.position)}));
    if(keyed.some(k=>typeof k.at!=='string'))return null;
    const sorted=(keyed as {e:typeof all[number];at:string;position:number}[]).sort(legacyBefore);
    const rest=cursor?sorted.filter(k=>legacyBefore(cursor!,k)<0):sorted;
    rows=rest.slice(0,limit+1).map(k=>k.e);
  }
  if(!rows)return null;
  const page=rows.slice(0,limit);const after=await be.revision(owner);if(after!==rev)return 'race';
  const last=page[page.length-1];
  return{rows:page.map(r=>r.payload as Record<string,unknown>),next:null,nextCursor:rows.length>limit&&last?encodeCursor(String((last.payload as {at:string}).at),Number(last.position)):null,revision:rev};
}
export async function readMemberHistory(be:SliceBackend,owner:string,q:{member:string;collection:HistoryCollection;branches?:string[]|null;before?:number;limit?:number}):Promise<HistoryPage|null|'race'>{
  if(!HISTORY_COLLECTIONS.includes(q.collection)||!q.member)return null;
  const limit=Math.max(1,Math.min(HISTORY_PAGE_MAX,Math.floor(q.limit??50)));
  if(!await isEntityLayout(be,owner))return null;
  const rev=await be.revision(owner);if(rev===null)return null;
  const [m]=await be.entities(owner,{collections:['members'],ids:[q.member],branches:q.branches??null});
  if(!m)return null;
  const rows=await be.entities(owner,{collections:[q.collection],match:{field:'member',values:[q.member]},branches:q.branches??null,desc:true,limit:limit+1,...(q.before!==undefined?{before:q.before}:{})});
  const page=rows.slice(0,limit);
  const after=await be.revision(owner);if(after!==rev)return 'race'; // a write landed between the reads: the caller answers with a retryable status, never 'member missing'
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
