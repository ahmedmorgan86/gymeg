import {test} from 'node:test';
import assert from 'node:assert/strict';
import config from '../next.config.ts';

test('enforced CSP carries only non-inline directives; full policy stays Report-Only',async()=>{
 const rules=await config.headers();
 const all=rules.flatMap(r=>r.headers);
 const enforced=all.find(h=>h.key==='Content-Security-Policy');
 const report=all.find(h=>h.key==='Content-Security-Policy-Report-Only');
 assert.ok(enforced&&report);
 assert.equal(enforced.value,"frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
 assert.ok(!/script-src|style-src|default-src/.test(enforced.value),'enforced policy must not restrict scripts or styles');
 assert.match(report.value,/script-src/);
 assert.ok(all.some(h=>h.key==='X-Frame-Options'&&h.value==='DENY'));
});
