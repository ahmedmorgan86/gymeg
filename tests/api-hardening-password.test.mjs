import {test, beforeEach, after} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { url: 'data:text/javascript,export{}', shortCircuit: true };
    try { return next(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context);
      throw error;
    }
  },
  load(url, context, next) {
    if (url.endsWith('/app/lib/auth.ts')) return { format: 'module', shortCircuit: true, source: 'export const serverAuth=async()=>globalThis.__hardeningAuth;' };
    if (url.endsWith('/app/lib/seo.ts')) return { format: 'module', shortCircuit: true, source: "export const siteOrigin=()=>'https://gym.example';" };
    if (url.endsWith('/app/lib/server-workspace.ts')) return { format: 'module', shortCircuit: true, source: `
      export const reply=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'private, no-store'}});
      export const sameOrigin=request=>request.headers.get('origin')===new URL(request.url).origin;
    ` };
    return next(url, context);
  }
});

const {POST} = await import('../app/api/password/route.ts');
const {resetAuthRateLimits} = await import('../app/lib/auth-rate-limit.ts');

const previousTrust = process.env.GYMEG_TRUST_PROXY_IP;
process.env.GYMEG_TRUST_PROXY_IP = '1';
after(() => {
  if (previousTrust === undefined) delete process.env.GYMEG_TRUST_PROXY_IP;
  else process.env.GYMEG_TRUST_PROXY_IP = previousTrust;
});

beforeEach(() => {
  resetAuthRateLimits();
  globalThis.__resetCalls = [];
  globalThis.__updateCalls = [];
  globalThis.__hardeningAuth = {
    auth: {
      resetPasswordForEmail: async (email, options) => { globalThis.__resetCalls.push({email, options}); return {error: null}; },
      getUser: async () => ({error: null, data: {user: {id: 'u1', email: 'owner@example.test'}}}),
      updateUser: async attributes => { globalThis.__updateCalls.push(attributes); return {error: null}; }
    }
  };
});

function passwordRequest(body, ip = '1.2.3.4') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request('https://gym.example/api/password', {
    method: 'POST',
    headers: {origin: 'https://gym.example', 'content-type': 'application/json', 'x-forwarded-for': ip},
    body: payload
  });
}

test('A14: repeated password-reset requests hit 429 with Retry-After and stop emailing', async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await POST(passwordRequest({action: 'request', email: 'owner@example.test'}));
    assert.equal(response.status, 200, `attempt ${attempt + 1}`);
  }
  const blocked = await POST(passwordRequest({action: 'request', email: 'owner@example.test'}));
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('Retry-After')) > 0);
  assert.equal((await blocked.json()).error, 'rate');
  assert.equal(globalThis.__resetCalls.length, 5);
  assert.equal(globalThis.__resetCalls[0].email, 'owner@example.test');
  assert.equal(globalThis.__resetCalls[0].options, undefined);
});

test('A14: reset buckets are keyed by email and IP', async () => {
  for (let attempt = 0; attempt < 5; attempt++) assert.equal((await POST(passwordRequest({action: 'request', email: 'limited@example.test'}))).status, 200);
  assert.equal((await POST(passwordRequest({action: 'request', email: 'limited@example.test'}))).status, 429);
  assert.equal((await POST(passwordRequest({action: 'request', email: 'other@example.test'}))).status, 200);
  assert.equal((await POST(passwordRequest({action: 'request', email: 'limited@example.test'}, '9.9.9.9'))).status, 200);
});

test('A14: password updates are rate limited after the authenticated user is resolved', async () => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await POST(passwordRequest({action: 'update', password: 'a-valid-password'}));
    assert.equal(response.status, 200, `attempt ${attempt + 1}`);
  }
  const blocked = await POST(passwordRequest({action: 'update', password: 'a-valid-password'}));
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('Retry-After')) > 0);
  assert.equal(globalThis.__updateCalls.length, 5);
});

test('A14: oversized password bodies are rejected before reaching Supabase', async () => {
  const response = await POST(passwordRequest({action: 'request', email: 'owner@example.test', pad: 'x'.repeat(3000)}));
  assert.equal(response.status, 413);
  assert.equal(globalThis.__resetCalls.length, 0);
});
