import {demandOwnerAllowed} from '../../../lib/demand-owner-scope';
import {sliceBackend} from '../../../lib/workspace-reads';
import {isEntityLayout} from '../../../lib/member-history';
import {assertRequestTenant} from '../../../lib/request-tenant';
import {ReadBudgetError} from '../../../lib/bounded-read';
import {CommercialError} from '../../../lib/licensing';
import {context,readSpaceMeta,reply} from '../../../lib/server-workspace';
import {withScope} from '../../../lib/database';
import {packetQueries} from '../../../lib/workspace-packet';
import {dayAt,addDays} from '../../../lib/domain';
import {readVisitTrend} from '../../../lib/visit-trend-page';
import type {Scope} from '../../../lib/member-console-source';
export const dynamic='force-dynamic';
/** Default-off (GYMOS_VISIT_TREND=1). ?branch=&today=&period= : visits per day over [today+1-2*period, today]. Same role and branch scope as the packet (needs visits and members). */
export async function GET(request:Request){try{
 if(process.env.GYMOS_VISIT_TREND!=='1')return reply({error:'notFound'},404);
 const ctx=await context();if(!ctx)return reply({error:'auth'},401);if(!demandOwnerAllowed(ctx.owner))return reply({error:'notFound'},404);assertRequestTenant(request,ctx.tenantId,Boolean(ctx.license));
 const be=sliceBackend();if(!be.supportsOpen||!await isEntityLayout(be,ctx.owner))return reply({error:"unsupported"},501);
 const url=new URL(request.url),branch=url.searchParams.get('branch')??'';
 if(!branch)return reply({error:'invalid'},400);
 if(ctx.branches&&!ctx.branches.includes(branch))return reply({error:'forbidden'},403);
 const meta=await readSpaceMeta(ctx.owner);
 const cols=new Set(packetQueries(ctx,meta.state.settings).flatMap(q=>q.collections as string[]));
 if(!cols.has('visits')||!cols.has('members'))return reply({error:'forbidden'},403);
 // `today` is client supplied: accept only the club's own day +-2 (clock skew / timezone edge), so a caller cannot pick arbitrary windows (cache keys, scan range)
 const today=url.searchParams.get('today')??'',own=dayAt(new Date().toISOString(),meta.state.settings.timezone);
 if(!/^\d{4}-\d\d-\d\d$/.test(today)||today<addDays(own,-2)||today>addDays(own,2))return reply({error:'invalid'},400);
 return reply(await readVisitTrend(withScope as unknown as Scope,{owner:ctx.owner,branch,today,period:Number(url.searchParams.get('period')??'')}));
 }catch(e){if(e instanceof CommercialError)return reply({error:e.code},e.status);if(e instanceof RangeError)return reply({error:'invalid'},400);if(e instanceof ReadBudgetError)return reply({error:'budget'},503);console.error('[Visit Trend Error]:',e);return reply({error:'server'},500);}}
