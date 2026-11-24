import {demandOwnerAllowed} from '../../../lib/demand-owner-scope';
import {sliceBackend} from '../../../lib/workspace-reads';
import {isEntityLayout} from '../../../lib/member-history';
import {assertRequestTenant} from '../../../lib/request-tenant';
import {ReadBudgetError} from '../../../lib/bounded-read';
import {CommercialError} from '../../../lib/licensing';
import {context,readSpaceMeta,reply} from '../../../lib/server-workspace';
import {withScope} from '../../../lib/database';
import {packetQueries} from '../../../lib/workspace-packet';
import {readLastVisits} from '../../../lib/last-visits-page';
import type {Scope} from '../../../lib/member-console-source';
export const dynamic='force-dynamic';
/** Default-off (GYMOS_LAST_VISITS=1). ?branch=&today= : latest visit day <= today per member of the branch. Same role and branch scope as the packet (needs visits and members). */
export async function GET(request:Request){try{
 if(process.env.GYMOS_LAST_VISITS!=='1')return reply({error:'notFound'},404);
 const ctx=await context();if(!ctx)return reply({error:'auth'},401);if(!demandOwnerAllowed(ctx.owner))return reply({error:'notFound'},404);assertRequestTenant(request,ctx.tenantId,Boolean(ctx.license));
 const be=sliceBackend();if(!be.supportsOpen||!await isEntityLayout(be,ctx.owner))return reply({error:"unsupported"},501);
 const url=new URL(request.url),branch=url.searchParams.get('branch')??'';
 if(!branch)return reply({error:'invalid'},400);
 if(ctx.branches&&!ctx.branches.includes(branch))return reply({error:'forbidden'},403);
 const meta=await readSpaceMeta(ctx.owner);
 const cols=new Set(packetQueries(ctx,meta.state.settings).flatMap(q=>q.collections as string[]));
 if(!cols.has('visits')||!cols.has('members'))return reply({error:'forbidden'},403);
 return reply(await readLastVisits(withScope as unknown as Scope,{owner:ctx.owner,branch,today:url.searchParams.get('today')??''}));
 }catch(e){if(e instanceof CommercialError)return reply({error:e.code},e.status);if(e instanceof RangeError)return reply({error:'invalid'},400);if(e instanceof ReadBudgetError)return reply({error:'budget'},503);console.error('[Last Visits Error]:',e);return reply({error:'server'},500);}}
