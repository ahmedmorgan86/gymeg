import {demandOwnerAllowed} from '../../../lib/demand-owner-scope';
import {sliceBackend} from '../../../lib/workspace-reads';
import {isEntityLayout} from '../../../lib/member-history';
import {assertRequestTenant} from '../../../lib/request-tenant';
import {ReadBudgetError} from '../../../lib/bounded-read';
import {CommercialError} from '../../../lib/licensing';
import {context,readSpaceMeta,reply} from '../../../lib/server-workspace';
import {withScope} from '../../../lib/database';
import {packetQueries} from '../../../lib/workspace-packet';
import {readPaymentsSummary,readPaymentsExport} from '../../../lib/payments-page';
import type {Scope} from '../../../lib/member-console-source';
export const dynamic='force-dynamic';
/** Default-off (GYMOS_PAYMENTS=1). ?mode=summary&today=&period= : month collection total and per-day money trend of one branch; ?mode=export : keyset pages of the branch's payments for the CSV.
 * Same role and branch scope as the packet: a caller whose packet omits payments (reception without a payment grant) gets 403. */
export async function GET(request:Request){try{
 if(process.env.GYMOS_PAYMENTS!=='1')return reply({error:'notFound'},404);
 const ctx=await context();if(!ctx)return reply({error:'auth'},401);if(!demandOwnerAllowed(ctx.owner))return reply({error:'notFound'},404);assertRequestTenant(request,ctx.tenantId,Boolean(ctx.license));
 const be=sliceBackend();if(!be.supportsOpen||!await isEntityLayout(be,ctx.owner))return reply({error:"unsupported"},501);
 const url=new URL(request.url),branch=url.searchParams.get('branch')??'',mode=url.searchParams.get('mode');
 if(!branch||(mode!=='summary'&&mode!=='export'))return reply({error:'invalid'},400);
 if(ctx.branches&&!ctx.branches.includes(branch))return reply({error:'forbidden'},403);
 const meta=await readSpaceMeta(ctx.owner);
 const cols=new Set(packetQueries(ctx,meta.state.settings).flatMap(q=>q.collections as string[]));
 if(!cols.has('payments')||!cols.has('members'))return reply({error:'forbidden'},403);
 if(mode==='summary')return reply(await readPaymentsSummary(withScope as unknown as Scope,{owner:ctx.owner,branch,today:url.searchParams.get('today')??'',period:Number(url.searchParams.get('period'))}));
 const afterRaw=url.searchParams.get('after'),afterId=url.searchParams.get('afterId'),ver=url.searchParams.get('ver');
 return reply(await readPaymentsExport(withScope as unknown as Scope,{owner:ctx.owner,branch,...(afterRaw!==null?{after:{pos:Number(afterRaw),id:afterId??''},ver:ver??undefined}:{})}));
 }catch(e){if(e instanceof CommercialError)return reply({error:e.code},e.status);if(e instanceof RangeError)return reply({error:'invalid'},400);if(e instanceof ReadBudgetError)return reply({error:'budget'},503);console.error('[Payments Error]:',e);return reply({error:'server'},500);}}
