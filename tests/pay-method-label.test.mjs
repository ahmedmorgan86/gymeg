import {test} from 'node:test';import assert from 'node:assert/strict';
import {payMethodLabel} from '../app/lib/pay-method.ts';
test('payment method labels: known methods localized, legacy or inherited keys fall back to raw text',()=>{
  assert.equal(payMethodLabel('cash',true),'نقدي');assert.equal(payMethodLabel('cash',false),'Cash');
  assert.equal(payMethodLabel('card',false),'Card');assert.equal(payMethodLabel('transfer',true),'تحويل');
  for(const k of ['constructor','toString','__proto__','hasOwnProperty','instapay',''])assert.equal(payMethodLabel(k,false),k,k);
});
