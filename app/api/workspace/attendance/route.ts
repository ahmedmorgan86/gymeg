import {assertRequestTenant} from '../../../lib/request-tenant';
import {CommercialError} from '../../../lib/licensing';
import {context,readSpaceMeta,reply} from '../../../lib/server-workspace';
import {withScope} from '../../../lib/database';
import {packetQueries} from '../../../lib/workspace-packet';
import {readAttendance} from '../../../lib/attendance-page';
import type {Scope} from '../../../lib/member-console-source';
export const dynamic='force-dynamic';
/** Default-off (GYMOS_ATTENDANCE=1). Branch check-ins today and the newest 100 visits in the Attendance page order. Same role and branch scope as the packet. */
export async function GET(request:Request){try{
 if(process.env.GYMOS_ATTENDANCE!=='1')return reply({error:'notFound'},404);
 const ctx=await context();if(!ctx)return reply({error:'auth'},401);assertRequestTenant(request,ctx.tenantId,Boolean(ctx.license));
 const url=new URL(request.url),branch=url.searchParams.get('branch')??'',day=url.searchParams.get('day')??'';
 if(!branch||!/^\d{4}-\d\d-\d\d$/.test(day))return reply({error:'invalid'},400);
 if(ctx.branches&&!ctx.branches.includes(branch))return reply({error:'forbidden'},403);
 const meta=await readSpaceMeta(ctx.owner);
 const cols=new Set(packetQueries(ctx,meta.state.settings).flatMap(q=>q.collections as string[]));
 if(!cols.has('visits')||!cols.has('members'))return reply({error:'forbidden'},403);
 return reply(await readAttendance(withScope as unknown as Scope,{owner:ctx.owner,branch,day}));
 }catch(e){if(e instanceof CommercialError)return reply({error:e.code},e.status);if(e instanceof RangeError)return reply({error:'invalid'},400);console.error('[Attendance Error]:',e);return reply({status:'fallback',reason:'unavailable'});}}
