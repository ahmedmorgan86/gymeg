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
    if (url.endsWith('/app/lib/server-workspace.ts')) return { format: 'module', shortCircuit: true, source: `
      export const reply=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'private, no-store'}});
      export const sameOrigin=request=>request.headers.get('origin')===new URL(request.url).origin;
    ` };
    return next(url, context);
  }
});

const {DELETE, POST} = await import('../app/api/session/route.ts');
const {resetAuthRateLimits} = await import('../app/lib/auth-rate-limit.ts');

const previousTrust = process.env.GYMEG_TRUST_PROXY_IP;
process.env.GYMEG_TRUST_PROXY_IP = '1';
after(() => {
  if (previousTrust === undefined) delete process.env.GYMEG_TRUST_PROXY_IP;
  else process.env.GYMEG_TRUST_PROXY_IP = previousTrust;
});

beforeEach(() => {
  resetAuthRateLimits();
  globalThis.__signOutOptions = [];
  globalThis.__signInCalls = [];
  globalThis.__hardeningAuth = {
    auth: {
      signOut: async options => { globalThis.__signOutOptions.push(options); return {error: null}; },
      signInWithPassword: async credentials => { globalThis.__signInCalls.push(credentials); return {error: null, data: {session: {access_token: 'local'}}}; }
    }
  };
});

function loginRequest(email = 'owner@example.test', ip = '1.2.3.4') {
  return new Request('https://gym.example/api/session', {
    method: 'POST',
    headers: {origin: 'https://gym.example', 'content-type': 'application/json', 'x-forwarded-for': ip},
    body: JSON.stringify({email, password: 'valid-password'})
  });
}

test('A13: sign-out revokes every device session using the global Supabase scope', async () => {
  const response = await DELETE(new Request('https://gym.example/api/session', {method: 'DELETE', headers: {origin: 'https://gym.example'}}));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {ok: true});
  assert.deepEqual(globalThis.__signOutOptions, [{scope: 'global'}]);
});

test('A14: repeated logins from the same IP and email receive 429 with Retry-After', async () => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await POST(loginRequest());
    assert.equal(response.status, 200, `attempt ${attempt + 1}`);
  }
  const blocked = await POST(loginRequest());
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('Retry-After') !== null, true);
  assert.ok(Number(blocked.headers.get('Retry-After')) > 0);
  assert.equal((await blocked.json()).error, 'rate_limit');
  assert.equal(globalThis.__signInCalls.length, 10, 'blocked request must not reach Supabase');
});

test('A14: rate-limit buckets are isolated by email and by client IP', async () => {
  for (let attempt = 0; attempt < 10; attempt++) assert.equal((await POST(loginRequest('same@example.test', '5.5.5.5'))).status, 200);
  assert.equal((await POST(loginRequest('same@example.test', '5.5.5.5'))).status, 429);
  assert.equal((await POST(loginRequest('other@example.test', '5.5.5.5'))).status, 200);
  assert.equal((await POST(loginRequest('same@example.test', '6.6.6.6'))).status, 200);
});

test('A14: oversized login bodies are rejected before authentication', async () => {
  const response = await POST(new Request('https://gym.example/api/session', {
    method: 'POST',
    headers: {origin: 'https://gym.example', 'content-type': 'application/json', 'x-forwarded-for': '1.2.3.4'},
    body: JSON.stringify({email: 'owner@example.test', password: 'valid-password', pad: 'x'.repeat(5000)})
  }));
  assert.equal(response.status, 413);
  assert.equal(globalThis.__signInCalls.length, 0);
});
