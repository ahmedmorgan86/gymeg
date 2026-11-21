import {sliceBackend} from '../../../lib/workspace-reads';
import {isEntityLayout} from '../../../lib/member-history';
import {assertRequestTenant} from '../../../lib/request-tenant';
import {ReadBudgetError} from '../../../lib/bounded-read';
import {CommercialError} from '../../../lib/licensing';
import {context,readSpaceMeta,reply} from '../../../lib/server-workspace';
import {withScope} from '../../../lib/database';
import {packetQueries} from '../../../lib/workspace-packet';
import {readReportPayments} from '../../../lib/report-payments-page';
import type {Scope} from '../../../lib/member-console-source';
export const dynamic='force-dynamic';
/** Default-off (GYMOS_REPORT_PAYMENTS=1). ?branch=&from=&to= [&after=day&afterPos=&afterId=&ver=] : the branch's payments of a day range with allocation breakdown and member name, in keyset pages.
 * Same role and branch scope as the packet: needs payments, invoices and members in packetQueries (reception without a payment grant gets 403). */
export async function GET(request:Request){try{
 if(process.env.GYMOS_REPORT_PAYMENTS!=='1')return reply({error:'notFound'},404);
 const ctx=await context();if(!ctx)return reply({error:'auth'},401);assertRequestTenant(request,ctx.tenantId,Boolean(ctx.license));
 const be=sliceBackend();if(!be.supportsOpen||!await isEntityLayout(be,ctx.owner))return reply({error:'unsupported'},501);
 const url=new URL(request.url),branch=url.searchParams.get('branch')??'';
 if(!branch)return reply({error:'invalid'},400);
 if(ctx.branches&&!ctx.branches.includes(branch))return reply({error:'forbidden'},403);
 const meta=await readSpaceMeta(ctx.owner);
 const cols=new Set(packetQueries(ctx,meta.state.settings).flatMap(q=>q.collections as string[]));
 if(!cols.has('payments')||!cols.has('invoices')||!cols.has('members'))return reply({error:'forbidden'},403);
 const g=(k:string)=>url.searchParams.get(k),afterDay=g('after');
 return reply(await readReportPayments(withScope as unknown as Scope,{owner:ctx.owner,branch,branches:ctx.branches??null,from:g('from')??'',to:g('to')??'',...(afterDay!==null?{after:{day:afterDay,pos:Number(g('afterPos')),id:g('afterId')??''},ver:g('ver')??undefined}:{})}));
 }catch(e){if(e instanceof CommercialError)return reply({error:e.code},e.status);if(e instanceof RangeError)return reply({error:'invalid'},400);if(e instanceof ReadBudgetError)return reply({error:'budget'},503);console.error('[Report Payments Error]:',e);return reply({error:'server'},500);}}
