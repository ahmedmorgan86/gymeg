import {test, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

// Android system-browser OAuth handoff: challenge-carrying start route,
// cookie-less android callback branch, and the single-use exchange endpoint
// bound to the app instance's verifier.
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

const {GET: startGET} = await import('../app/api/auth/google/route.ts');
const {GET: callbackGET} = await import('../app/api/auth/google/callback/route.ts');
const {POST: exchangePOST} = await import('../app/api/auth/mobile/exchange/route.ts');
const handoff = await import('../app/lib/mobile-handoff.ts');
const {decodeSession} = await import('../app/lib/supabase-session-codec.ts');

const CONFIRMED = { id: 'u1', email: 'owner@example.com', email_confirmed_at: '2026-01-01T00:00:00Z' };
const VERIFIER = handoff.newHandoffVerifier();
const CHALLENGE = handoff.handoffChallenge(VERIFIER);

let store;
let savedEnv;

function mockFetch() {
  global.fetch = async (url) => {
    const u = new URL(url);
    if (u.host === 'oauth2.googleapis.com') return { ok: true, status: 200, json: async () => ({ id_token: 'google-id-token' }) };
    if (u.host === 'ref.supabase.co') return { ok: true, status: 200, json: async () => ({ access_token: 'supa-acc', refresh_token: 'supa-ref', user: CONFIRMED }) };
    throw new Error('unexpected host ' + u.host);
  };
}

beforeEach(() => {
  savedEnv = { ...process.env };
  process.env.NODE_ENV = 'test';
  process.env.GYMOS_AUTH_BACKEND = 'supabase';
  process.env.GYMEG_GOOGLE_CLIENT_ID = 'client-id';
  process.env.GYMEG_GOOGLE_CLIENT_SECRET = 'client-secret';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://ref.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
  const jar = new Map();
  store = { jar, get: (n) => (jar.has(n) ? { value: jar.get(n) } : undefined), set: (n, v) => { jar.set(n, v); }, delete: (n) => { jar.delete(n); } };
  globalThis.__testCookies = store;
  handoff.__handoffTest.clear();
});
afterEach(() => {
  process.env = savedEnv;
  delete global.fetch;
  delete globalThis.__testCookies;
});

test('start route carries android client and challenge in the state cookie', async () => {
  const response = await startGET(new Request(`https://gym.example/api/auth/google?client=android-members&hc=${CHALLENGE}`));
  assert.equal(response.status, 303);
  const stateCookie = store.jar.get('gymos_google_state');
  const [, target, client, hc] = stateCookie.split('.');
  assert.equal(target, 'c');
  assert.equal(client, 'android-members');
  assert.equal(hc, CHALLENGE);
});

test('start route rejects an android client without a well-formed challenge', async () => {
  for (const q of ['client=android-members', `client=android-members&hc=short`, `client=android-other&hc=${CHALLENGE}`]) {
    const response = await startGET(new Request('https://gym.example/api/auth/google?' + q));
    assert.equal(response.headers.get('location'), 'https://gym.example/sign-in?error=google_failed', q);
    assert.equal(store.jar.has('gymos_google_state'), false, q);
  }
});

test('android callback stores a handoff instead of setting the session cookie', async () => {
  mockFetch();
  store.jar.set('gymos_google_state', `STATE123.c.android-members.${CHALLENGE}`);
  store.jar.set('gymos_google_nonce', 'NONCE123');
  const response = await callbackGET(new Request('https://gym.example/api/auth/google/callback?code=authcode&state=STATE123'));
  assert.equal(response.status, 303);
  const location = new URL(response.headers.get('location'));
  assert.equal(location.pathname, '/auth/mobile/callback/members');
  assert.equal(location.searchParams.get('client'), 'android-members');
  const code = location.searchParams.get('code');
  assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  // No session cookie in the browser that ran the callback.
  assert.equal(store.jar.has('gymos_session'), false);

  // The app exchanges code + verifier for the session cookie.
  const exchange = await exchangePOST(new Request('https://gym.example/api/auth/mobile/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, verifier: VERIFIER, client: 'android-members' }),
  }));
  assert.equal(exchange.status, 204);
  const setCookie = exchange.headers.get('set-cookie');
  assert.match(setCookie, /^gymos_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+/);
  const session = decodeSession(setCookie.split(';')[0].slice('gymos_session='.length));
  assert.deepEqual(session, { a: 'supa-acc', r: 'supa-ref' });

  // Replay is impossible: the code was consumed atomically.
  const replay = await exchangePOST(new Request('https://gym.example/api/auth/mobile/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, verifier: VERIFIER, client: 'android-members' }),
  }));
  assert.equal(replay.status, 401);
  assert.equal(replay.headers.get('set-cookie'), null);
});

test('exchange rejects a wrong verifier and a wrong client without setting a cookie', async () => {
  mockFetch();
  store.jar.set('gymos_google_state', `STATE123.c.android-management.${CHALLENGE}`);
  store.jar.set('gymos_google_nonce', 'NONCE123');
  const response = await callbackGET(new Request('https://gym.example/api/auth/google/callback?code=authcode&state=STATE123'));
  const code = new URL(response.headers.get('location')).searchParams.get('code');

  const wrongVerifier = handoff.newHandoffVerifier();
  const bad = await exchangePOST(new Request('https://gym.example/api/auth/mobile/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, verifier: wrongVerifier, client: 'android-management' }),
  }));
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get('set-cookie'), null);

  // A wrong proof must NOT burn the code: the legitimate app's correct
  // verifier still succeeds afterwards (predicates live inside the atomic
  // delete, so only a fully matching presentation consumes the row).
  const after = await exchangePOST(new Request('https://gym.example/api/auth/mobile/exchange', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, verifier: VERIFIER, client: 'android-management' }),
  }));
  assert.equal(after.status, 204);
  assert.match(after.headers.get('set-cookie'), /^gymos_session=/);
});

test('exchange validates body shapes', async () => {
  for (const body of ['not json', '{}', JSON.stringify({ code: 'x', verifier: 'y', client: 'web' })]) {
    const response = await exchangePOST(new Request('https://gym.example/api/auth/mobile/exchange', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    }));
    assert.equal(response.status, 400, body);
    assert.equal(response.headers.get('set-cookie'), null);
  }
});

test('callback rejects a partial android marker in the state cookie', async () => {
  mockFetch();
  store.jar.set('gymos_google_state', 'STATE123.c.android-members');
  store.jar.set('gymos_google_nonce', 'NONCE123');
  const response = await callbackGET(new Request('https://gym.example/api/auth/google/callback?code=authcode&state=STATE123'));
  assert.equal(response.headers.get('location'), 'https://gym.example/sign-in?error=google_failed');
  assert.equal(store.jar.has('gymos_session'), false);
});

test('handoff table: runtime row secrecy and expiry cleanup evidence', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  // Only the handoff store may reference the table at runtime: no route,
  // page, or other lib can read session rows out of it.
  const roots = ['app', 'components'];
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (statSync(file).isDirectory()) { walk(file); continue; }
      if (!/\.(ts|tsx|mjs)$/.test(name)) continue;
      const text = readFileSync(file, 'utf8');
      if (text.includes('auth_handoff_codes') && !file.endsWith('app/lib/mobile-handoff.ts')) offenders.push(file);
    }
  };
  for (const root of roots) walk(new URL('../' + root, import.meta.url).pathname);
  assert.deepEqual(offenders, []);
  // The migration keeps the table gymos_app-only with FORCE RLS, and the
  // store sweeps expired rows on every create so secrets never linger.
  const migration = readFileSync(new URL('../supabase/migrations/20261121210000_auth_handoff_codes.sql', import.meta.url), 'utf8');
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON gymos\.auth_handoff_codes FROM PUBLIC,anon,authenticated/);
  assert.doesNotMatch(migration, /GRANT .*TO (anon|authenticated)/);
  const storeSource = readFileSync(new URL('../app/lib/mobile-handoff.ts', import.meta.url), 'utf8');
  assert.match(storeSource, /DELETE FROM gymos\.auth_handoff_codes WHERE expires_at <= now\(\)/);
});

test('web sign-in path is unchanged by the handoff support', async () => {
  mockFetch();
  store.jar.set('gymos_google_state', 'STATE123.p');
  store.jar.set('gymos_google_nonce', 'NONCE123');
  const response = await callbackGET(new Request('https://gym.example/api/auth/google/callback?code=authcode&state=STATE123'));
  assert.equal(response.headers.get('location'), 'https://gym.example/platform');
  assert.ok(store.jar.has('gymos_session'));
});
