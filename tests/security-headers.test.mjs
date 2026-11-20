import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import config from '../next.config.ts';

test('All routes receive baseline defense-in-depth security headers',async()=>{
 const rules=await config.headers();
 const global=rules.find(rule=>rule.source==='/:path*');
 assert.ok(global,'global header rule is required');
 const headers=Object.fromEntries(global.headers.map(h=>[h.key,h.value]));
 assert.equal(headers['X-Content-Type-Options'],'nosniff');
 assert.equal(headers['X-Frame-Options'],'DENY');
 assert.equal(headers['Referrer-Policy'],'strict-origin-when-cross-origin');
 assert.match(headers['Permissions-Policy'],/camera=\(self\)/);
 assert.match(headers['Strict-Transport-Security'],/max-age=/);
 const apk=rules.find(rule=>rule.source.startsWith('/downloads/'));
 assert.ok(apk?.headers.some(h=>h.key==='Content-Disposition'));
});

test('Password recovery uses Firebase hosted action without an untrusted redirect',async()=>{
 const route=await readFile(new URL('../app/api/password/route.ts',import.meta.url),'utf8');
 const auth=await readFile(new URL('../app/lib/auth.ts',import.meta.url),'utf8');
 assert.match(route,/resetPasswordForEmail\(body\.email\.trim\(\)\)/);
 assert.match(auth,/requestType: 'PASSWORD_RESET', email/);
 assert.doesNotMatch(auth,/continueUrl:.*redirectTo/);
});
