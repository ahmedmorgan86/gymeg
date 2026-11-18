import {test} from 'node:test';import assert from 'node:assert/strict';
import {assertRequestTenant} from '../app/lib/request-tenant.ts';
test('A stale browser tab cannot apply its operation to a newly selected club',()=>{
  const postRequest=id=>new Request('https://gym.test/api/workspace',{method:'POST',headers:id?{'x-gymos-tenant':id}:{}});
  const getRequest=id=>new Request('https://gym.test/api/workspace',{method:'GET',headers:id?{'x-gymos-tenant':id}:{}});
  assert.doesNotThrow(()=>assertRequestTenant(postRequest('club-a'),'club-a',true));
  for(const id of ['club-b',undefined])assert.throws(()=>assertRequestTenant(postRequest(id),'club-a',true),error=>error.code==='clubChanged'&&error.status===409);
  assert.doesNotThrow(()=>assertRequestTenant(postRequest(),'legacy',false));
  assert.doesNotThrow(()=>assertRequestTenant(getRequest('club-a'),'club-a',true));
  assert.doesNotThrow(()=>assertRequestTenant(getRequest(),'club-a',true));
  assert.throws(()=>assertRequestTenant(getRequest('club-b'),'club-a',true),error=>error.code==='clubChanged'&&error.status===409);
});
