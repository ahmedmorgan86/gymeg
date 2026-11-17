import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {POST} from '../app/api/backup/route.ts';
import {emptyState} from '../app/lib/domain.ts';

function setup({role='owner',branches=null,license=null,grants}={}){
  const state=emptyState();
  state.branches.push({id:'other',name:'Other branch'});
  if(grants)state.settings.receptionGrants=grants;
  globalThis.__qaSpace={state,revision:0};
  globalThis.__qaContext={role,branches,owner:'qa-owner',tenantId:'qa-tenant',license,user:{userId:'qa-user',displayName:'QA owner',email:'qa@example.invalid'}};
}
function backupFor(tenant='qa-tenant',settings={}){
  const state=emptyState();
  state.branches.push({id:'other',name:'Other branch'});
  state.settings={...state.settings,...settings};
  const digest=createHash('sha256').update(JSON.stringify(state)).digest('hex');
  return {format:'gymos-backup',version:2,tenant,createdAt:new Date().toISOString(),revision:0,digest,state};
}
function request(body){return new Request('https://gym.example/api/backup',{method:'POST',headers:{origin:'https://gym.example','Content-Type':'application/json'},body:JSON.stringify(body)});}
function restoreRequest(extra={}){return request({action:'restore',confirm:'RESTORE',revision:globalThis.__qaSpace.revision,backup:backupFor(),...extra});}

test('Full restore requires an owner or an explicitly granted full-scope manager',async()=>{
  setup({role:'manager',branches:['main','other']});
  assert.equal((await POST(restoreRequest())).status,403,'full-scope manager without grant');
  setup({role:'owner'});
  assert.equal((await POST(restoreRequest())).status,200,'owner');
  setup({role:'manager',branches:['main','other'],grants:{'qa-user':['backup.restore']}});
  assert.equal((await POST(restoreRequest())).status,200,'granted full-scope manager');
  setup({role:'manager',branches:['main'],grants:{'qa-user':['backup.restore']}});
  assert.equal((await POST(restoreRequest())).status,403,'granted manager with partial scope');
  setup({role:'reception',branches:['main','other'],grants:{'qa-user':['backup.restore']}});
  assert.equal((await POST(restoreRequest())).status,403,'reception with grant');
});

test('Current staff grants survive restore and backup grants are never imported',async()=>{
  setup({role:'owner',grants:{'qa-user':['visit.scan']}});
  const incoming=backupFor('qa-tenant',{receptionGrants:{foreign:['payment.add']}});
  assert.equal((await POST(restoreRequest({backup:incoming}))).status,200);
  assert.deepEqual(globalThis.__qaSpace.state.settings.receptionGrants,{'qa-user':['visit.scan']});
  setup({role:'owner'});
  assert.equal((await POST(restoreRequest({backup:incoming}))).status,200);
  assert.equal(globalThis.__qaSpace.state.settings.receptionGrants,undefined);
});

test('Foreign tenant backups are rejected without an import bypass',async()=>{
  for(const flag of [true,false]){
    setup({role:'owner'});
    const foreign=backupFor(randomUUID());
    const status=(await POST(restoreRequest({backup:foreign,importTenant:flag}))).status;
    assert.equal(status,400,`foreign tenant with importTenant=${flag}`);
  }
  setup({role:'owner'});
  assert.equal((await POST(restoreRequest({backup:backupFor('qa-owner')}))).status,200,'verified legacy partition');
});
