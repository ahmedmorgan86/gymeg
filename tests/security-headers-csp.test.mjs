import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import config from '../next.config.ts';

test('next.config.ts keeps core security headers without overriding dynamic nonce CSP',async()=>{
 const rules=await config.headers();
 const all=rules.flatMap(r=>r.headers);
 assert.ok(all.some(h=>h.key==='X-Frame-Options'&&h.value==='DENY'));
 assert.ok(all.some(h=>h.key==='X-Content-Type-Options'&&h.value==='nosniff'));
 assert.ok(all.some(h=>h.key==='Strict-Transport-Security'));
 assert.ok(!all.some(h=>h.key==='Content-Security-Policy'||h.key==='Content-Security-Policy-Report-Only'));
});

test('proxy.ts enforces per-request nonce-based CSP and layout.tsx opts into dynamic rendering',()=>{
 const proxySource=readFileSync(join(process.cwd(),'proxy.ts'),'utf8');
 assert.match(proxySource,/x-nonce/);
 assert.match(proxySource,/Content-Security-Policy/);
 assert.match(proxySource,/script-src 'self' 'nonce-\$\{nonce\}' 'strict-dynamic' 'wasm-unsafe-eval'/);
 assert.match(proxySource,/frame-ancestors 'none'/);
 assert.match(proxySource,/object-src 'none'/);
 const layoutSource=readFileSync(join(process.cwd(),'app','layout.tsx'),'utf8');
 assert.match(layoutSource,/force-dynamic/);
 assert.match(layoutSource,/headers\(\)/);
});
