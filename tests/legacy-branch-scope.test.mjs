import {test} from 'node:test';
import assert from 'node:assert/strict';
import {legacyBranchScope} from '../app/lib/access.ts';

test('legacy non-commercial branch scope fails closed for non-owners',()=>{
 for(const raw of ['null','false','0','{"a":1}','"main"','["main",1]','[["a"]]','not json',null,undefined,false,0,{a:1}])assert.deepEqual(legacyBranchScope(raw,'manager'),[],String(raw));
 assert.deepEqual(legacyBranchScope('null','reception'),[]);
 assert.deepEqual(legacyBranchScope('["main","b2"]','manager'),['main','b2']);
 assert.deepEqual(legacyBranchScope(['main'],'reception'),['main']);
 assert.deepEqual(legacyBranchScope('[]','manager'),[]);
 assert.equal(legacyBranchScope('null','owner'),null);
 assert.equal(legacyBranchScope(null,'owner'),null);
});
