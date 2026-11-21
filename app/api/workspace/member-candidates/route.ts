import {sliceBackend} from '../../../lib/workspace-reads';
import {isEntityLayout} from '../../../lib/member-history';
import {assertRequestTenant} from '../../../lib/request-tenant';
import {CommercialError} from '../../../lib/licensing';
import {context,readSpaceMeta,reply} from '../../../lib/server-workspace';
import {withScope} from '../../../lib/database';
import {packetQueries} from '../../../lib/workspace-packet';
import {readConsoleCandidates,type Scope} from '../../../lib/member-console-source';
export const dynamic='force-dynamic';
/** Default-off (GYMOS_MEMBER_SUMMARIES=1). Stored member candidates for the console list. 'fallback' (HTTP 200) means: keep the legacy full-state list. */
export async function GET(request:Request){try{
 if(process.env.GYMOS_MEMBER_SUMMARIES!=='1')return reply({error:'notFound'},404);
 const ctx=await context();if(!ctx)return reply({error:'auth'},401);assertRequestTenant(request,ctx.tenantId,Boolean(ctx.license));
 const be=sliceBackend();if(!be.supportsOpen||!await isEntityLayout(be,ctx.owner))return reply({error:'unsupported'},501); // bounded reads need the Postgres entity layout: fail closed before any DB read
 const url=new URL(request.url),branch=url.searchParams.get('branch')??'',since=url.searchParams.get('since');
 if(!branch||branch.length>200||(since!==null&&!/^\d{1,20}$/.test(since)))return reply({error:'invalid'},400);
 const meta=await readSpaceMeta(ctx.owner);
 const cols=new Set(packetQueries(ctx,meta.state.settings).flatMap(q=>q.collections as string[]));
 const financial=cols.has('payments')&&cols.has('invoices');
 if(!cols.has('members'))return reply({error:'forbidden'},403);
 const out=await readConsoleCandidates(withScope as unknown as Scope,{owner:ctx.owner,tenantId:ctx.tenantId,branch,branches:ctx.branches??null,financial,since});
 if(out.status==='forbidden')return reply({error:'forbidden'},403);
 return reply(out);
 }catch(e){if(e instanceof CommercialError)return reply({error:e.code},e.status);console.error('[Member Candidates Error]:',e);return reply({status:'fallback',reason:'unavailable'});}}
