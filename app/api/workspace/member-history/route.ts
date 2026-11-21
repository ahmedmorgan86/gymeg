import {assertRequestTenant} from '../../../lib/request-tenant';
import {CommercialError} from '../../../lib/licensing';
import {context,readSpaceMeta,reply} from '../../../lib/server-workspace';
import {sliceBackend} from '../../../lib/workspace-reads';
import {HISTORY_COLLECTIONS,isEntityLayout,HISTORY_PAGE_MAX,historyScope,readMemberHistory,readMemberVisitsByAt,type HistoryCollection} from '../../../lib/member-history';
export const dynamic='force-dynamic';
/** Default-off (GYMOS_MEMBER_HISTORY=1). Paged, newest-first member history. Same role and branch scope as the packet. */
export async function GET(request:Request){try{
 if(process.env.GYMOS_MEMBER_HISTORY!=='1')return reply({error:'notFound'},404);
 const ctx=await context();if(!ctx)return reply({error:'auth'},401);assertRequestTenant(request,ctx.tenantId,Boolean(ctx.license));
 const url=new URL(request.url),member=url.searchParams.get('member')??'',collection=url.searchParams.get('collection') as HistoryCollection;
 const num=(k:string)=>{const v=url.searchParams.get(k);if(v===null)return undefined;if(!/^\d{1,12}$/.test(v))throw new RangeError(k);return Number(v);};
 if(!member||member.length>200||!(HISTORY_COLLECTIONS as readonly string[]).includes(collection))return reply({error:'invalid'},400);
 const before=num('before'),limit=num('limit');if(limit!==undefined&&(limit<1||limit>HISTORY_PAGE_MAX))return reply({error:'invalid'},400);
 const be=sliceBackend();if(!be.supportsOpen)return reply({error:'unsupported'},501); // bounded reads need the Postgres entity layout
 if(!await isEntityLayout(be,ctx.owner))return reply({error:'unsupported'},501);
 const meta=await readSpaceMeta(ctx.owner);
 const scope=historyScope(ctx,meta.state.settings,collection);if(!scope.allowed)return reply({error:'forbidden'},403);
 if(url.searchParams.get('order')==='at'){if(collection!=='visits')return reply({error:'invalid'},400);const cur=url.searchParams.get('cursor')??undefined;const p=await readMemberVisitsByAt(be,ctx.owner,{member,branches:scope.branches,cursor:cur,limit});if(p==='badCursor')return reply({error:'invalid'},400);if(p==='race')return reply({error:'retry'},409);if(p==='missing')return reply({error:'notFound'},404);if(!p)return reply({error:'unsupported'},501);return reply(p);}
 const page=await readMemberHistory(be,ctx.owner,{member,collection,branches:scope.branches,before,limit});
 if(page==='race')return reply({error:'retry'},409); // a write landed between the reads
 if(!page)return reply({error:'notFound'},404); // unknown member or member outside the caller's branches
 return reply(page);
 }catch(e){if(e instanceof CommercialError)return reply({error:e.code},e.status);if(e instanceof RangeError)return reply({error:'invalid'},400);console.error('[Member History Error]:',e);return reply({error:'unavailable'},503);}}
