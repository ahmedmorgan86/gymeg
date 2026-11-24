import {demandOwnerAllowed} from '../../../lib/demand-owner-scope';
import {sliceBackend} from '../../../lib/workspace-reads';
import {isEntityLayout} from '../../../lib/member-history';
import {assertRequestTenant} from '../../../lib/request-tenant';
import {CommercialError} from '../../../lib/licensing';
import {context,readSpaceMeta,reply} from '../../../lib/server-workspace';
import {withScope} from '../../../lib/database';
import {packetQueries} from '../../../lib/workspace-packet';
import {readQuotaIssues} from '../../../lib/quota-issues-source';
import type {Scope} from '../../../lib/member-console-source';
export const dynamic='force-dynamic';
/** Default-off (GYMOS_QUOTA_ISSUES=1). ?branch=&since= : the members of the branch with a quota issue now (server clock). 'fallback' (HTTP 200) = unknown, keep the legacy path. Issue classification only. */
export async function GET(request:Request){try{
 if(process.env.GYMOS_QUOTA_ISSUES!=='1')return reply({error:'notFound'},404);
 const ctx=await context();if(!ctx)return reply({error:'auth'},401);if(!demandOwnerAllowed(ctx.owner))return reply({error:'notFound'},404);assertRequestTenant(request,ctx.tenantId,Boolean(ctx.license));
 const be=sliceBackend();if(!be.supportsOpen||!await isEntityLayout(be,ctx.owner))return reply({error:'unsupported'},501);
 const url=new URL(request.url),branch=url.searchParams.get('branch')??'',since=url.searchParams.get('since');
 if(!branch||branch.length>200||(since!==null&&since.length>60))return reply({error:'invalid'},400);
 const meta=await readSpaceMeta(ctx.owner);
 const cols=new Set(packetQueries(ctx,meta.state.settings).flatMap(q=>q.collections as string[]));
 if(!cols.has('members')||!cols.has('visits'))return reply({error:'forbidden'},403);
 const out=await readQuotaIssues(withScope as unknown as Scope,{owner:ctx.owner,branch,branches:ctx.branches??null,settings:meta.state.settings,now:new Date().toISOString(),since});
 if(out.status==='forbidden')return reply({error:'forbidden'},403);
 return reply(out);
 }catch(e){if(e instanceof CommercialError)return reply({error:e.code},e.status);console.error('[Quota Issues Error]:',e);return reply({status:'fallback',reason:'unavailable'});}}
