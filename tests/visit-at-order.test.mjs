import {test} from 'node:test';import assert from 'node:assert/strict';
// The SQL order uses plain code-point comparison on the canonical ISO form the server writes. Prove it equals the legacy String.localeCompare on that form.
let x=12345;const r=n=>{x=(x*1103515245+12345)&0x7fffffff;return x%n;};const p=(n,w)=>String(n).padStart(w,'0');
const iso=()=>`${p(2024+r(5),4)}-${p(1+r(12),2)}-${p(1+r(28),2)}T${p(r(24),2)}:${p(r(60),2)}:${p(r(60),2)}.${p(r(1000),3)}Z`;
const canon=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
test('localeCompare (default, ar, en) agrees with code-point order on canonical ISO strings',()=>{
  const sg=n=>Math.sign(n);let n=0;
  for(let i=0;i<60000;i++){const a=iso(),b=r(3)?iso():a.slice(0,r(2)?22:19)+(r(2)?String(r(10)):'.'+p(r(1000),3))+(r(2)?'Z':'Z');if(!canon.test(b))continue;
    const c=a<b?-1:a>b?1:0;for(const loc of [undefined,'ar','en'])assert.equal(sg(a.localeCompare(b,loc)),c,`${a} vs ${b} (${loc})`);n++;}
  assert.ok(n>30000,String(n));
});
test('non-canonical forms really do diverge, so the SQL guard is needed',()=>{
  const a='2026-02-04T09:00:00.000Z',b='2026-02-04T09:00:00+02:00';
  assert.equal(a<b,false);assert.equal(a.localeCompare(b)<0,true); // code-point and locale order disagree here
});
