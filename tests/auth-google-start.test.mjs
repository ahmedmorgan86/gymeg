import {test, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {createHash} from 'node:crypto';

// Google OAuth start route: state+nonce cookies and the authorize redirect.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { url: 'data:text/javascript,export{}', shortCircuit: true };
    if (specifier === 'next/headers') return { url: 'data:text/javascript,export const cookies=async()=>globalThis.__testCookies;', shortCircuit: true };
    try { return next(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context);
      throw error;
    }
  },
});

const {GET} = await import('../app/api/auth/google/route.ts');

let store;
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  process.env.GYMEG_GOOGLE_CLIENT_ID = 'client-id';
  process.env.GYMEG_GOOGLE_CLIENT_SECRET = 'client-secret';
  const jar = new Map();
  store = { jar, get: (n) => (jar.has(n) ? { value: jar.get(n) } : undefined), set: (n, v) => { jar.set(n, v); }, delete: (n) => { jar.delete(n); } };
  globalThis.__testCookies = store;
});
afterEach(() => {
  process.env = savedEnv;
  delete globalThis.__testCookies;
});

test('start route sets state+nonce cookies and redirects to Google with a hex-hashed nonce', async () => {
  const response = await GET(new Request('https://gym.example/api/auth/google?returnTo=/platform'));
  assert.equal(response.status, 303);
  const location = new URL(response.headers.get('location'));
  assert.equal(location.host, 'accounts.google.com');
  // State: param matches the cookie prefix, target suffix selects /platform.
  const stateCookie = store.jar.get('gymos_google_state');
  assert.ok(stateCookie.endsWith('.p'));
  assert.equal(location.searchParams.get('state'), stateCookie.split('.')[0]);
  // Nonce: Google receives the LOWERCASE-HEX SHA-256 of the raw cookie value
  // (the encoding GoTrue's token_oidc.go uses for its comparison).
  const rawNonce = store.jar.get('gymos_google_nonce');
  assert.ok(rawNonce.length > 20);
  const expected = createHash('sha256').update(rawNonce).digest('hex');
  assert.equal(location.searchParams.get('nonce'), expected);
  assert.match(location.searchParams.get('nonce'), /^[0-9a-f]{64}$/);
  // The rest of the authorize request is the deployment's own client.
  assert.equal(location.searchParams.get('client_id'), 'client-id');
  assert.equal(location.searchParams.get('redirect_uri'), 'https://gym.example/api/auth/google/callback');
  assert.equal(location.searchParams.get('response_type'), 'code');
});

test('start route fails closed when the OAuth client is not configured', async () => {
  delete process.env.GYMEG_GOOGLE_CLIENT_SECRET;
  const response = await GET(new Request('https://gym.example/api/auth/google'));
  assert.equal(response.headers.get('location'), 'https://gym.example/sign-in?error=google_unavailable');
  assert.equal(store.jar.has('gymos_google_state'), false);
  assert.equal(store.jar.has('gymos_google_nonce'), false);
});
