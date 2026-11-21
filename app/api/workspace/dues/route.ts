import {sliceBackend} from '../../../lib/workspace-reads';
import {isEntityLayout} from '../../../lib/member-history';
import {assertRequestTenant} from '../../../lib/request-tenant';
import {ReadBudgetError} from '../../../lib/bounded-read';
import {CommercialError} from '../../../lib/licensing';
import {context,readSpaceMeta,reply} from '../../../lib/server-workspace';
import {withScope} from '../../../lib/database';
import {packetQueries} from '../../../lib/workspace-packet';
import {readDues} from '../../../lib/dues-page';
import type {Scope} from '../../../lib/member-console-source';
export const dynamic='force-dynamic';
/** Default-off (GYMOS_DUES=1). Branch invoices with outstanding balances for the Operations dues tab (headline total plus keyset pages). Same role and branch scope as the packet. */
export async function GET(request:Request){try{
 if(process.env.GYMOS_DUES!=='1')return reply({error:'notFound'},404);
 const ctx=await context();if(!ctx)return reply({error:'auth'},401);assertRequestTenant(request,ctx.tenantId,Boolean(ctx.license));
 const be=sliceBackend();if(!be.supportsOpen||!await isEntityLayout(be,ctx.owner))return reply({error:'unsupported'},501); // bounded reads need the Postgres entity layout: fail closed before any DB read
 const url=new URL(request.url),branch=url.searchParams.get('branch')??'';
 if(!branch)return reply({error:'invalid'},400);
 if(ctx.branches&&!ctx.branches.includes(branch))return reply({error:'forbidden'},403);
 if(ctx.role==='reception')return reply({error:'forbidden'},403); // owner/admin-only, the same rule the Operations tab applies
 const meta=await readSpaceMeta(ctx.owner);
 const cols=new Set(packetQueries(ctx,meta.state.settings).flatMap(q=>q.collections as string[]));
 if(!cols.has('invoices')||!cols.has('payments')||!cols.has('members'))return reply({error:'forbidden'},403);
  const afterRaw=url.searchParams.get('after'),afterId=url.searchParams.get('afterId'),ver=url.searchParams.get('ver');const after=afterRaw===null?undefined:{pos:Number(afterRaw),id:afterId??''};
 return reply(await readDues(withScope as unknown as Scope,{owner:ctx.owner,branch,branches:ctx.branches??null,...(url.searchParams.get('member')!==null?{member:url.searchParams.get('member')!}:{}),...(after!==undefined?{after,ver:ver??undefined}:{})}));
 }catch(e){if(e instanceof CommercialError)return reply({error:e.code},e.status);if(e instanceof RangeError)return reply({error:'invalid'},400);if(e instanceof ReadBudgetError)return reply({error:'budget'},503);console.error('[Dues Error]:',e);return reply({error:'unavailable'},503);}}
