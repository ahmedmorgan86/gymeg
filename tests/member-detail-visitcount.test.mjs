import {test} from 'node:test';import assert from 'node:assert/strict';
import {visitCountView} from '../app/use-member-detail.ts';
test('visit count: strict legacy fallback is unknown (null), never a zero from an omitted list',()=>{
  assert.equal(visitCountView({visitCount:0,source:'legacy'},true),null);
  assert.equal(visitCountView({visitCount:7,source:'detail'},true),7);
  assert.equal(visitCountView({visitCount:0,source:'detail'},true),0);
  assert.equal(visitCountView({visitCount:4,source:'legacy'},false),4);
});
