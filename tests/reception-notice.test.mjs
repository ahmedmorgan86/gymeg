import {test} from 'node:test';
import assert from 'node:assert/strict';
import {limitedReceptionNotice,receptionPermitted} from '../app/lib/access.ts';
test('limited access copy matches explicit reception grants without changing authority',()=>{
 assert.equal(limitedReceptionNotice('reception',['member.details'],true,false),true);
 for(const [role,grants,writable,support] of [['reception',[],true,false],['reception',undefined,true,false],['reception',['member.details'],false,false],['reception',['member.details'],true,true],['manager',['member.details'],true,false]])assert.equal(limitedReceptionNotice(role,grants,writable,support),false);
 assert.equal(receptionPermitted('reception','member.details',['member.details']),true);
 assert.equal(receptionPermitted('reception','member.details',[]),false);
 assert.equal(receptionPermitted('reception','design.save',['member.details']),false);
});
