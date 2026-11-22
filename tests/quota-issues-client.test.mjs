import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}}});
const {chooseQuotaIssues}=await import('../app/use-quota-issues.ts');
const A={},B={};const got={owner:'o',branch:'a',day:'d',forState:A,quota:new Set(['m'])};
test('held set is used only for the same state, owner, branch and day and only when ON',()=>{
  assert.equal(chooseQuotaIssues(true,got,A,'o','a','d'),got.quota);
  for(const args of [[B,'o','a','d'],[A,'x','a','d'],[A,'o','b','d'],[A,'o','a','e']])assert.equal(chooseQuotaIssues(true,got,...args),null);
  assert.equal(chooseQuotaIssues(false,got,A,'o','a','d'),null);assert.equal(chooseQuotaIssues(true,null,A,'o','a','d'),null);
});
test('Overview contract: legacy when OFF; base without packet visits + set; unknown only in strict with a visit-limited period; day mismatch is unknown',()=>{
  const w=readFileSync(new URL('../app/workspace.tsx',import.meta.url),'utf8'),h=readFileSync(new URL('../app/use-quota-issues.ts',import.meta.url),'utf8');
  assert.match(w,/if\(!QUOTA_ISSUES_ON\)return membershipIssue\(s,m,today\)/);
  assert.match(w,/membershipIssue\(\{\.\.\.s,visits:\[\]\},m,today\)/);
  assert.match(w,/qStrict&&!m\.archived&&membershipPeriods\(m\)\.some\(p=>p\.visits!=null\)\?"unknown"/);
  assert.match(w,/quotaUnknown\?"—":String\(active\.length\)/);
  assert.match(h,/d\.day===day/);
  assert.equal((w.match(/membershipIssue\(s,m,today\)/g)??[]).length,1,'only the OFF branch reads packet visits');
});
