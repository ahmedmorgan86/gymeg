import {test} from 'node:test';import assert from 'node:assert/strict';
import {completeDemo} from '../app/lib/complete-demo.ts';import {emptyState} from '../app/lib/domain.ts';
const NOW='2026-11-21T10:00:00.000Z';
function build(n){const s=emptyState();s.settings.name='نادي تجريبي Demo Club';return completeDemo(s,n,NOW);}
function sections(s){const out=new Set();for(const [k,v] of Object.entries(s)){if(Array.isArray(v)&&v.length>0)out.add(k);else if(v&&typeof v==='object'&&!Array.isArray(v))for(const [k2,v2] of Object.entries(v))if(Array.isArray(v2)&&v2.length>0)out.add(k+'.'+k2);}return out;}
test('seed script default is a bounded small count, still overridable',async()=>{
  const {readFileSync}=await import('node:fs');
  assert.match(readFileSync(new URL('../scripts/seed-complete-demo.mjs',import.meta.url),'utf8'),/GYMOS_DEMO_COUNT\?\?11\b/);
});
test('11 fictional members cover every populated section that 1000 does, in both branches, at a fraction of the size',()=>{
  const small=build(11),large=build(1000);
  const a=sections(small),b=sections(large);
  assert.ok(b.size>=30,'coverage sanity');
  assert.deepEqual([...b].filter(k=>!a.has(k)),[]);
  assert.equal(small.members.length,11);
  const ratio=JSON.stringify(small).length/JSON.stringify(large).length;
  assert.ok(ratio<0.2,'ratio '+ratio);
  // Both branches hold members, and no cross-branch references exist.
  const byBranch=Object.groupBy(small.members,m=>m.branch);
  assert.equal(Object.keys(byBranch).length,2);
  for(const m of small.members){for(const v of small.visits.filter(v=>v.member===m.id))assert.equal(v.branch,m.branch);for(const i of small.invoices.filter(i=>i.member===m.id))assert.equal(i.branch,m.branch);}
});
test('followUps coverage is not accidental: it needs 3 surviving pulse proposals in one branch, and N=11 provides them',()=>{
  const s=build(11);
  assert.ok(s.followUps.length>=1);
  const perBranch={};for(const p of s.pulse)perBranch[p.branch]=(perBranch[p.branch]??0)+1;
  assert.ok(Math.max(...Object.values(perBranch))>=3,JSON.stringify(perBranch));
  for(const f of s.followUps)assert.ok(s.members.some(m=>m.id===f.member&&m.branch===f.branch));
});
