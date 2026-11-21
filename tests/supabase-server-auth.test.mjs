import {test, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context);
      throw error;
    }
  },
});

const { authBackend } = await import('../app/lib/auth-backend.ts');
const { supabaseServerAuth } = await import('../app/lib/supabase-server-auth.ts');

// Minimal cookie store double matching the next/headers shape the impl uses.
function fakeStore(initial = {}) {
  const jar = new Map(Object.entries(initial));
  return {
    jar,
    get: (name) => (jar.has(name) ? { value: jar.get(name) } : undefined),
    set: (name, value) => { jar.set(name, value); },
    delete: (name) => { jar.delete(name); },
  };
}

const encodeSession = (a, r) => Buffer.from(JSON.stringify({ a, r }), 'utf8').toString('base64url');
const CONFIRMED = { id: 'u1', email: 'user@example.com', email_confirmed_at: '2026-01-01T00:00:00Z', user_metadata: { name: 'User' } };
const UNCONFIRMED = { id: 'u2', email: 'new@example.com', email_confirmed_at: null };

// Programmable GoTrue: handlers keyed on "METHOD path".
let calls;
let routes;
function mockFetch(handlers) {
  calls = [];
  routes = handlers;
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const key = (opts.method ?? 'GET') + ' ' + u.pathname.replace('/auth/v1', '') + u.search;
    calls.push({ key, body: opts.body ? JSON.parse(opts.body) : undefined, auth: opts.headers?.authorization });
    const handler = routes[key] ?? routes[(opts.method ?? 'GET') + ' ' + u.pathname.replace('/auth/v1', '')];
    if (!handler) throw new Error('unexpected call ' + key);
    const { status, json } = typeof handler === 'function' ? handler(opts) : handler;
    return { ok: status >= 200 && status < 300, status, json: async () => json };
  };
}

let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://ref.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
});
afterEach(() => {
  process.env = savedEnv;
  delete global.fetch;
});

test('authBackend selector: legacy default, explicit supabase, fail closed on typos', () => {
  delete process.env.GYMOS_AUTH_BACKEND;
  assert.equal(authBackend(), 'firebase');
  process.env.GYMOS_AUTH_BACKEND = '';
  assert.equal(authBackend(), 'firebase');
  process.env.GYMOS_AUTH_BACKEND = 'firebase';
  assert.equal(authBackend(), 'firebase');
  process.env.GYMOS_AUTH_BACKEND = 'supabase';
  assert.equal(authBackend(), 'supabase');
  process.env.GYMOS_AUTH_BACKEND = 'supabse';
  assert.throws(() => authBackend(), /GYMOS_AUTH_BACKEND/);
});

test('getUser verifies at the auth server and shapes the confirmed user', async () => {
  mockFetch({ 'GET /user': { status: 200, json: CONFIRMED } });
  const store = fakeStore({ gymos_session: encodeSession('acc', 'ref') });
  const { auth } = supabaseServerAuth(store);
  const { data } = await auth.getUser();
  assert.equal(data.user.id, 'u1');
  assert.equal(data.user.email, 'user@example.com');
  assert.equal(data.user.user_metadata.name, 'User');
  assert.equal(calls[0].auth, 'Bearer acc');
});

test('getUser rejects unconfirmed accounts (email gate)', async () => {
  mockFetch({ 'GET /user': { status: 200, json: { user: UNCONFIRMED } } });
  const store = fakeStore({ gymos_session: encodeSession('acc', 'ref') });
  const { auth } = supabaseServerAuth(store);
  assert.equal((await auth.getUser()).data.user, null);
});

test('getUser never rotates: the middleware boundary owns refresh', async () => {
  let refreshCalls = 0;
  mockFetch({
    'GET /user': { status: 401, json: { error_code: 'bad_jwt' } },
    'POST /token?grant_type=refresh_token': () => { refreshCalls++; return { status: 200, json: {} }; },
  });
  const store = fakeStore({ gymos_session: encodeSession('acc', 'ref') });
  const { auth } = supabaseServerAuth(store);
  assert.equal((await auth.getUser()).data.user, null);
  assert.equal(refreshCalls, 0);
  // Cookie untouched — no rotation, no clear, in a writable store either.
  assert.equal(store.jar.get('gymos_session'), encodeSession('acc', 'ref'));
});

test('signInWithPassword maps provider outcomes without leaking which one', async () => {
  const grant = 'POST /token?grant_type=password';
  // Success sets the session cookie.
  mockFetch({ [grant]: { status: 200, json: { access_token: 'a', refresh_token: 'r', user: CONFIRMED } } });
  let store = fakeStore();
  let result = await supabaseServerAuth(store).auth.signInWithPassword({ email: 'user@example.com', password: 'secret-password' });
  assert.equal(result.error, null);
  assert.equal(result.data.session.access_token, 'a');
  assert.ok(store.jar.has('gymos_session'));

  const cases = [
    [{ status: 400, json: { error_code: 'invalid_credentials' } }, 401, 'invalid_credentials'],
    [{ status: 400, json: { error_code: 'email_not_confirmed' } }, 403, 'email_not_confirmed'],
    [{ status: 429, json: {} }, 429, undefined],
    [{ status: 500, json: {} }, 503, undefined],
  ];
  for (const [response, status, code] of cases) {
    mockFetch({ [grant]: response });
    result = await supabaseServerAuth(fakeStore()).auth.signInWithPassword({ email: 'user@example.com', password: 'x'.repeat(12) });
    assert.equal(result.data.session, null);
    assert.equal(result.error.status, status);
    if (code) assert.equal(result.error.code, code);
  }
  // Network failure is a 503, not a credential error.
  global.fetch = async () => { throw new Error('down'); };
  result = await supabaseServerAuth(fakeStore()).auth.signInWithPassword({ email: 'user@example.com', password: 'x'.repeat(12) });
  assert.equal(result.error.status, 503);
});

test('signUp sets a session only when the provider returns one', async () => {
  // Confirmation off: session in the response.
  mockFetch({ 'POST /signup': { status: 200, json: { access_token: 'a', refresh_token: 'r', user: CONFIRMED } } });
  let store = fakeStore();
  let result = await supabaseServerAuth(store).auth.signUp({ email: 'new@example.com', password: 'x'.repeat(12), name: 'New' });
  assert.equal(result.error, null);
  assert.equal(result.data.session.access_token, 'a');
  // Confirmation on: user but no session, still no error.
  mockFetch({ 'POST /signup': { status: 200, json: { user: UNCONFIRMED } } });
  store = fakeStore();
  result = await supabaseServerAuth(store).auth.signUp({ email: 'new@example.com', password: 'x'.repeat(12), name: 'New' });
  assert.equal(result.error, null);
  assert.equal(result.data.session, null);
  assert.equal(store.jar.has('gymos_session'), false);
  // Duplicate email maps to email_exists.
  mockFetch({ 'POST /signup': { status: 422, json: { error_code: 'user_already_exists' } } });
  result = await supabaseServerAuth(fakeStore()).auth.signUp({ email: 'dup@example.com', password: 'x'.repeat(12), name: 'Dup' });
  assert.equal(result.error.code, 'email_exists');
});

test('signOut revokes globally at the auth server and clears both cookies', async () => {
  mockFetch({ 'POST /logout?scope=global': { status: 204, json: null } });
  const store = fakeStore({ gymos_session: encodeSession('acc', 'ref'), 'sb-token': 'mob' });
  const { auth } = supabaseServerAuth(store);
  const { error } = await auth.signOut({ scope: 'global' });
  assert.equal(error, null);
  assert.equal(calls[0].auth, 'Bearer acc');
  assert.equal(store.jar.size, 0);
});

test('signOut and updateUser surface server revocation failures', async () => {
  mockFetch({ 'POST /logout?scope=global': { status: 500, json: {} } });
  const store = fakeStore({ gymos_session: encodeSession('acc', 'ref') });
  const { error } = await supabaseServerAuth(store).auth.signOut({ scope: 'global' });
  assert.equal(error.status, 503);
  // Cookies are KEPT on failure: the session is still server-side valid and
  // the revocation must stay retryable.
  assert.ok(store.jar.has('gymos_session'));

  mockFetch({ 'POST /logout?scope=global': { status: 204, json: null } });
  const okStore = fakeStore({ gymos_session: encodeSession('acc', 'ref'), 'sb-token': 'mob' });
  const ok = await supabaseServerAuth(okStore).auth.signOut({ scope: 'global' });
  assert.equal(ok.error, null);
  assert.equal(okStore.jar.size, 0);

  mockFetch({
    'GET /user': { status: 200, json: CONFIRMED },
    'PUT /user': { status: 200, json: { user: CONFIRMED } },
    'POST /logout?scope=global': { status: 500, json: {} },
  });
  const result = await supabaseServerAuth(fakeStore({ gymos_session: encodeSession('acc', 'ref') })).auth.updateUser({ password: 'y'.repeat(12) });
  assert.equal(result.error.status, 503);
});

test('resetPasswordForEmail never reveals account existence', async () => {
  // Unknown address (provider 200/400 both) -> no error surfaced.
  for (const status of [200, 400, 422]) {
    mockFetch({ 'POST /recover': { status, json: {} } });
    const { error } = await supabaseServerAuth(fakeStore()).auth.resetPasswordForEmail('whoever@example.com');
    assert.equal(error, null);
  }
  // Throttling and outages do surface.
  mockFetch({ 'POST /recover': { status: 429, json: {} } });
  assert.equal((await supabaseServerAuth(fakeStore()).auth.resetPasswordForEmail('a@b.c')).error.status, 429);
  mockFetch({ 'POST /recover': { status: 500, json: {} } });
  assert.equal((await supabaseServerAuth(fakeStore()).auth.resetPasswordForEmail('a@b.c')).error.status, 503);
});

test('verifyEmailToken consumes token_hash links and opens a session', async () => {
  mockFetch({ 'POST /verify': { status: 200, json: { access_token: 'a', refresh_token: 'r', user: CONFIRMED } } });
  const store = fakeStore();
  const { data, error } = await supabaseServerAuth(store).auth.verifyEmailToken('hash', 'signup');
  assert.equal(error, null);
  assert.equal(data.session.access_token, 'a');
  assert.deepEqual(calls[0].body, { token_hash: 'hash', type: 'signup' });
  mockFetch({ 'POST /verify': { status: 403, json: { error_code: 'otp_expired' } } });
  const bad = await supabaseServerAuth(fakeStore()).auth.verifyEmailToken('hash', 'signup');
  assert.equal(bad.error.status, 400);
  assert.equal(bad.data.session, null);
});

test('signInWithIdToken exchanges a Google ID token for a session', async () => {
  mockFetch({ 'POST /token?grant_type=id_token': { status: 200, json: { access_token: 'a', refresh_token: 'r', user: CONFIRMED } } });
  const store = fakeStore();
  const { data, error } = await supabaseServerAuth(store).auth.signInWithIdToken('google', 'google-id-token');
  assert.equal(error, null);
  assert.equal(data.session.access_token, 'a');
  assert.deepEqual(calls[0].body, { provider: 'google', id_token: 'google-id-token' });
  mockFetch({ 'POST /token?grant_type=id_token': { status: 400, json: { error_code: 'validation_failed' } } });
  const bad = await supabaseServerAuth(fakeStore()).auth.signInWithIdToken('google', 'junk');
  assert.equal(bad.error.status, 401);
});

test('a read-only cookie store (Server Component) is never written or consulted for refresh', async () => {
  let refreshCalls = 0;
  mockFetch({
    'GET /user': { status: 401, json: { error_code: 'bad_jwt' } },
    'POST /token?grant_type=refresh_token': () => { refreshCalls++; return { status: 200, json: {} }; },
  });
  const store = fakeStore({ gymos_session: encodeSession('acc', 'ref') });
  store.set = () => { throw new Error('Cookies can only be modified in a Server Action or Route Handler'); };
  store.delete = () => { throw new Error('Cookies can only be modified in a Server Action or Route Handler'); };
  const { auth } = supabaseServerAuth(store);
  const { data } = await auth.getUser();
  assert.equal(data.user, null);
  assert.equal(refreshCalls, 0);
  assert.equal(store.jar.get('gymos_session'), encodeSession('acc', 'ref'));
});

test('a cookie rotated by the middleware boundary is used by the next getUser on the same object', async () => {
  mockFetch({ 'GET /user': { status: 200, json: CONFIRMED } });
  const store = fakeStore({ gymos_session: encodeSession('acc', 'ref') });
  const { auth } = supabaseServerAuth(store);
  await auth.getUser();
  // Middleware rotates between the two calls: the next read must see it.
  store.jar.set('gymos_session', encodeSession('acc2', 'ref2'));
  await auth.getUser();
  assert.equal(calls.at(-1).auth, 'Bearer acc2');
});

test('an oversized token pair fails loudly instead of truncating the cookie', async () => {
  const huge = 'x'.repeat(3000);
  mockFetch({ 'POST /token?grant_type=password': { status: 200, json: { access_token: huge, refresh_token: huge, user: CONFIRMED } } });
  const store = fakeStore();
  const result = await supabaseServerAuth(store).auth.signInWithPassword({ email: 'user@example.com', password: 'x'.repeat(12) });
  assert.equal(result.data.session, null);
  assert.equal(result.error.status, 503);
  assert.equal(store.jar.has('gymos_session'), false);
});

test('session-opening methods reject unconfirmed users; recovery is the exception', async () => {
  mockFetch({ 'POST /token?grant_type=id_token': { status: 200, json: { access_token: 'a', refresh_token: 'r', user: UNCONFIRMED } } });
  let store = fakeStore();
  let result = await supabaseServerAuth(store).auth.signInWithIdToken('google', 'tok');
  assert.equal(result.error.status, 403);
  assert.equal(result.error.code, 'email_not_confirmed');
  assert.equal(store.jar.has('gymos_session'), false);
  // Recovery sessions may precede confirmation.
  mockFetch({ 'POST /verify': { status: 200, json: { access_token: 'a', refresh_token: 'r', user: UNCONFIRMED } } });
  store = fakeStore();
  result = await supabaseServerAuth(store).auth.verifyEmailToken('hash', 'recovery');
  assert.equal(result.error, null);
  assert.equal(result.data.session.access_token, 'a');
  // Unsupported token types never reach the provider.
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; throw new Error('nope'); };
  result = await supabaseServerAuth(fakeStore()).auth.verifyEmailToken('hash', 'invite');
  assert.equal(result.error.status, 400);
  assert.equal(fetchCalled, false);
});

test('session-opening rejects a malformed or missing grant user', async () => {
  for (const user of [undefined, { id: 7, email: 'a@b.c' }, { id: 'u1' }]) {
    mockFetch({ 'POST /token?grant_type=password': { status: 200, json: { access_token: 'a', refresh_token: 'r', ...(user ? { user } : {}) } } });
    const store = fakeStore();
    const result = await supabaseServerAuth(store).auth.signInWithPassword({ email: 'a@b.c', password: 'x'.repeat(12) });
    assert.equal(result.data.session, null);
    assert.equal(result.error.status, 503);
    assert.equal(store.jar.has('gymos_session'), false);
  }
});

test('updateUser requires a session, rotates it, and signs out everywhere', async () => {
  // Not signed in.
  let result = await supabaseServerAuth(fakeStore()).auth.updateUser({ password: 'x'.repeat(12) });
  assert.equal(result.error.status, 401);
  // Too short.
  result = await supabaseServerAuth(fakeStore()).auth.updateUser({ password: 'short' });
  assert.equal(result.error.status, 400);
  // Signed in: password update then global revoke, local cookie dropped.
  mockFetch({
    'GET /user': { status: 200, json: CONFIRMED },
    'PUT /user': { status: 200, json: { user: CONFIRMED } },
    'POST /logout?scope=global': { status: 204, json: null },
  });
  const store = fakeStore({ gymos_session: encodeSession('acc', 'ref'), 'sb-token': 'mob' });
  result = await supabaseServerAuth(store).auth.updateUser({ password: 'y'.repeat(12) });
  assert.equal(result.error, null);
  assert.equal(result.data.user.id, 'u1');
  assert.equal(store.jar.has('gymos_session'), false);
  assert.equal(store.jar.has('sb-token'), false);
  assert.equal(calls.at(-1).key, 'POST /logout?scope=global');
});
