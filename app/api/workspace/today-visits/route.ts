import {sliceBackend} from '../../../lib/workspace-reads';
import {isEntityLayout} from '../../../lib/member-history';
import {assertRequestTenant} from '../../../lib/request-tenant';
import {ReadBudgetError} from '../../../lib/bounded-read';
import {CommercialError} from '../../../lib/licensing';
import {context,readSpaceMeta,reply} from '../../../lib/server-workspace';
import {withScope} from '../../../lib/database';
import {packetQueries} from '../../../lib/workspace-packet';
import {readTodayVisits} from '../../../lib/today-visits';
import type {Scope} from '../../../lib/member-console-source';
export const dynamic='force-dynamic';
/** Default-off (GYMOS_TODAY_VISITS=1). Count and latest visits of one branch-day. Same role and branch scope as the packet. */
export async function GET(request:Request){try{
 if(process.env.GYMOS_TODAY_VISITS!=='1')return reply({error:'notFound'},404);
 const ctx=await context();if(!ctx)return reply({error:'auth'},401);assertRequestTenant(request,ctx.tenantId,Boolean(ctx.license));
 const be=sliceBackend();if(!be.supportsOpen||!await isEntityLayout(be,ctx.owner))return reply({error:'unsupported'},501); // bounded reads need the Postgres entity layout: fail closed before any DB read
 const url=new URL(request.url),branch=url.searchParams.get('branch')??'',day=url.searchParams.get('day')??'';
 if(!branch||!/^\d{4}-\d\d-\d\d$/.test(day))return reply({error:'invalid'},400);
 if(ctx.branches&&!ctx.branches.includes(branch))return reply({error:'forbidden'},403);
 const meta=await readSpaceMeta(ctx.owner);
 const cols=new Set(packetQueries(ctx,meta.state.settings).flatMap(q=>q.collections as string[]));
 if(!cols.has('visits')||!cols.has('members'))return reply({error:'forbidden'},403);
 return reply({status:'ok',...await readTodayVisits(withScope as unknown as Scope,{owner:ctx.owner,branch,day})});
 }catch(e){if(e instanceof CommercialError)return reply({error:e.code},e.status);if(e instanceof RangeError)return reply({error:'invalid'},400);if(e instanceof ReadBudgetError)return reply({error:'budget'},503);console.error('[Today Visits Error]:',e);return reply({error:'unavailable'},503);}}
