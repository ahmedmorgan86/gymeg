import {test} from 'node:test';import assert from 'node:assert/strict';
import {completeDemo} from '../app/lib/complete-demo.ts';import {emptyState} from '../app/lib/domain.ts';
const NOW='2026-11-21T10:00:00.000Z';
function build(n){const s=emptyState();s.settings.name='نادي تجريبي Demo Club';return completeDemo(s,n,NOW);}
function sections(s){const out=new Set();for(const [k,v] of Object.entries(s)){if(Array.isArray(v)&&v.length>0)out.add(k);else if(v&&typeof v==='object'&&!Array.isArray(v))for(const [k2,v2] of Object.entries(v))if(Array.isArray(v2)&&v2.length>0)out.add(k+'.'+k2);}return out;}
test('seed script default is a bounded small count, still overridable',async()=>{
  const {readFileSync}=await import('node:fs');
  assert.match(readFileSync(new URL('../scripts/seed-complete-demo.mjs',import.meta.url),'utf8'),/GYMOS_DEMO_COUNT\?\?20\b/);
});
test('20 fictional members cover every populated section that 1000 does, at a fraction of the size',()=>{
  const small=build(20),large=build(1000);
  const a=sections(small),b=sections(large);
  assert.ok(b.size>=30,'coverage sanity');
  assert.deepEqual([...b].filter(k=>!a.has(k)),[]);
  assert.equal(small.members.length,20);
  const ratio=JSON.stringify(small).length/JSON.stringify(large).length;
  assert.ok(ratio<0.2,'ratio '+ratio);
});
