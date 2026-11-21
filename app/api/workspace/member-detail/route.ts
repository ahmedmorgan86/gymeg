import {assertRequestTenant} from '../../../lib/request-tenant';
import {CommercialError} from '../../../lib/licensing';
import {context,readSpaceMeta,reply} from '../../../lib/server-workspace';
import {withScope} from '../../../lib/database';
import {packetQueries} from '../../../lib/workspace-packet';
import {readMemberDetail,detailAsOf} from '../../../lib/member-detail-source';
import type {Scope} from '../../../lib/member-console-source';
export const dynamic='force-dynamic';
/** Default-off (GYMOS_MEMBER_SUMMARIES=1). One member's detail inputs. 'fallback' (HTTP 200) means: keep the legacy full-state detail. */
export async function GET(request:Request){try{
 if(process.env.GYMOS_MEMBER_SUMMARIES!=='1')return reply({error:'notFound'},404);
 const ctx=await context();if(!ctx)return reply({error:'auth'},401);assertRequestTenant(request,ctx.tenantId,Boolean(ctx.license));
 const url=new URL(request.url),member=url.searchParams.get('member')??'',asOf=url.searchParams.get('asOf')??undefined;
 if(!member||member.length>200||(asOf!==undefined&&asOf.length>40))return reply({error:'invalid'},400);
 const meta=await readSpaceMeta(ctx.owner);
 const cols=new Set(packetQueries(ctx,meta.state.settings).flatMap(q=>q.collections as string[]));
 if(!cols.has('members')||!cols.has('visits'))return reply({error:'forbidden'},403);
 const out=await readMemberDetail(withScope as unknown as Scope,{owner:ctx.owner,member,branches:ctx.branches??null,financial:cols.has('payments')&&cols.has('invoices'),settings:meta.state.settings,asOf:detailAsOf(asOf,Date.now())}); // only a screen clock within one day behind the server is honored
 if(out.status==='notFound')return reply({error:'notFound'},404);
 return reply(out);
 }catch(e){if(e instanceof CommercialError)return reply({error:e.code},e.status);console.error('[Member Detail Error]:',e);return reply({status:'fallback',reason:'unavailable'});}}
