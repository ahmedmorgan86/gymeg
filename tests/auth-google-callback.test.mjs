import {test, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

// Full Google-OAuth roundtrip through the REAL Supabase provider: state check,
// code exchange at Google, id_token grant at GoTrue, session cookie, redirect.
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

const {GET} = await import('../app/api/auth/google/callback/route.ts');
const {decodeSession} = await import('../app/lib/supabase-session-codec.ts');

const CONFIRMED = { id: 'u1', email: 'user@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' };
const UNCONFIRMED = { id: 'u2', email: 'new@example.com', email_confirmed_at: null };

let calls;
let store;
function mockFetch(user) {
  calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const host = u.host;
    calls.push({ host, path: u.pathname + u.search, body: opts.body ? String(opts.body) : undefined, headers: opts.headers });
    if (host === 'oauth2.googleapis.com') return { ok: true, status: 200, json: async () => ({ id_token: 'google-id-token' }) };
    if (host === 'ref.supabase.co') {
      if (!user) return { ok: false, status: 400, json: async () => ({ error_code: 'validation_failed' }) };
      return { ok: true, status: 200, json: async () => ({ access_token: 'supa-acc', refresh_token: 'supa-ref', user }) };
    }
    throw new Error('unexpected host ' + host);
  };
}

function makeStore() {
  const jar = new Map([['gymos_google_state', 'STATE123.c']]);
  return {
    jar,
    get: (name) => (jar.has(name) ? { value: jar.get(name) } : undefined),
    set: (name, value) => { jar.set(name, value); },
    delete: (name) => { jar.delete(name); },
  };
}

let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  process.env.GYMOS_AUTH_BACKEND = 'supabase';
  process.env.GYMEG_GOOGLE_CLIENT_ID = 'client-id';
  process.env.GYMEG_GOOGLE_CLIENT_SECRET = 'client-secret';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://ref.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
  store = makeStore();
  globalThis.__testCookies = store;
});
afterEach(() => {
  process.env = savedEnv;
  delete global.fetch;
  delete globalThis.__testCookies;
});

const url = (q) => new Request('https://gym.example/api/auth/google/callback?' + q);

test('Google roundtrip: state, code exchange, id_token grant, session cookie, redirect', async () => {
  mockFetch(CONFIRMED);
  const response = await GET(url('code=authcode&state=STATE123'));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), 'https://gym.example/clubs');
  // State cookie consumed.
  assert.equal(store.jar.has('gymos_google_state'), false);
  // Google saw the authorization-code exchange for THIS deployment's callback.
  const google = calls.find(c => c.host === 'oauth2.googleapis.com');
  assert.ok(google.body.includes('code=authcode'));
  assert.ok(google.body.includes('client_id=client-id'));
  assert.ok(google.body.includes('redirect_uri=' + encodeURIComponent('https://gym.example/api/auth/google/callback')));
  // GoTrue saw the Google ID token on the id_token grant.
  const grant = calls.find(c => c.host === 'ref.supabase.co');
  assert.equal(grant.path, '/auth/v1/token?grant_type=id_token');
  assert.deepEqual(JSON.parse(grant.body), { provider: 'google', id_token: 'google-id-token' });
  // Session cookie carries the Supabase pair.
  const session = decodeSession(store.jar.get('gymos_session'));
  assert.deepEqual(session, { a: 'supa-acc', r: 'supa-ref' });
});

test('platform target in state redirects to /platform', async () => {
  store.jar.set('gymos_google_state', 'STATE123.p');
  mockFetch(CONFIRMED);
  const response = await GET(url('code=authcode&state=STATE123'));
  assert.equal(response.headers.get('location'), 'https://gym.example/platform');
});

test('state mismatch fails before any network call', async () => {
  mockFetch(CONFIRMED);
  const response = await GET(url('code=authcode&state=WRONG'));
  assert.equal(response.headers.get('location'), 'https://gym.example/sign-in?error=google_failed');
  assert.equal(calls.length, 0);
});

test('unconfirmed Google account surfaces email_not_confirmed, no cookie', async () => {
  mockFetch(UNCONFIRMED);
  const response = await GET(url('code=authcode&state=STATE123'));
  assert.equal(response.headers.get('location'), 'https://gym.example/sign-in?error=email_not_confirmed');
  assert.equal(store.jar.has('gymos_session'), false);
});

test('provider rejection fails closed without a cookie', async () => {
  mockFetch(null);
  const response = await GET(url('code=authcode&state=STATE123'));
  assert.equal(response.headers.get('location'), 'https://gym.example/sign-in?error=google_failed');
  assert.equal(store.jar.has('gymos_session'), false);
});
