import {test} from 'node:test';
import assert from 'node:assert/strict';
import {context} from '../app/lib/server-workspace.ts';

const closedTrial={tenant_id:'t',plan_id:'custom',mode:'trial',status:'active',starts_at:new Date(Date.now()-60*86400000).toISOString(),ends_at:new Date(Date.now()-31*86400000).toISOString(),maintenance_until:null,limits:{branches:1,members:100,staff:5},revision:0};
const club=(license,extra={})=>({id:'t',storage_key:'tenant:t',name:'C',role:'owner',branches:null,license,...extra});

test('Real workspace boundary: expired trial blocks context(), allows context(true) for own opt-out paths',async()=>{
 globalThis.__ctxClub=club(closedTrial);
 await assert.rejects(()=>context(),e=>e.code==='trialExpired'&&e.status===403);
 const ctx=await context(true);
 assert.equal(ctx.owner,'tenant:t');assert.equal(ctx.role,'owner');assert.equal(ctx.license.mode,'trial');
});
test('Real workspace boundary: platformOwnerAccess and support views are not trial-locked; writable trial passes',async()=>{
 globalThis.__ctxClub=club(closedTrial,{platformOwnerAccess:true});
 assert.equal((await context()).owner,'tenant:t');
 globalThis.__ctxClub=club(closedTrial,{support:{kind:'platform'}});
 assert.equal((await context()).owner,'tenant:t');
 globalThis.__ctxClub=club({...closedTrial,ends_at:new Date(Date.now()+5*86400000).toISOString()});
 assert.equal((await context()).owner,'tenant:t');
});
