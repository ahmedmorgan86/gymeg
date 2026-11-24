import {test, beforeEach, after} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

// Unit tests for the real app/lib/auth.ts with its infrastructure stubbed:
// cookie store, Firebase Admin SDK and the Identity Toolkit REST endpoint.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { url: 'data:text/javascript,export{}', shortCircuit: true };
    if (specifier === 'next/headers') return { url: 'data:text/javascript,export const cookies=async()=>globalThis.__testCookies;', shortCircuit: true };
    if (specifier === 'firebase-admin/app') return { url: 'data:text/javascript,export const getApps=()=>globalThis.__testApps??[];', shortCircuit: true };
    if (specifier === 'firebase-admin/auth') return { url: 'data:text/javascript,export const getAuth=()=>globalThis.__testAuth;', shortCircuit: true };
    try { return next(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context);
      throw error;
    }
  },
  load(url, context, next) {
    if (url.endsWith('/app/lib/firestore-db.ts')) return { format: 'module', shortCircuit: true, source: 'export const isFirebaseConfigured=()=>true;export const isFirestorePersistence=()=>true;export const getFirestoreDb=()=>({});' };
    return next(url, context);
  }
});

const {serverAuth} = await import('../app/lib/auth.ts');

function cookieStore(initial = {}) {
  const jar = {...initial};
  const calls = {set: [], delete: []};
  return {
    calls,
    get: name => (name in jar ? {value: jar[name]} : undefined),
    set: (name, value, options) => { calls.set.push({name, value, options}); jar[name] = value; },
    delete: name => { calls.delete.push(name); delete jar[name]; },
  };
}

const verifiedDecoded = {uid: 'user-1', email: 'owner@example.test', email_verified: true, name: 'Owner'};
const realFetch = globalThis.fetch;
const previousApiKey = process.env.FIREBASE_WEB_API_KEY;
process.env.FIREBASE_WEB_API_KEY = 'test-web-api-key';

beforeEach(() => {
  globalThis.__testApps = [{name: 'gymeg-workspace'}];
  globalThis.__testCookies = cookieStore();
  globalThis.__testAuth = {
    verifySessionCookie: async () => { throw Object.assign(new Error('bad cookie'), {code: 'auth/invalid-session-cookie'}); },
    verifyIdToken: async () => { throw Object.assign(new Error('bad token'), {code: 'auth/argument-error'}); },
    createSessionCookie: async () => 'minted-session-cookie',
    updateUser: async () => {},
    revokeRefreshTokens: async () => {},
  };
});

after(() => {
  globalThis.fetch = realFetch;
  if (previousApiKey === undefined) delete process.env.FIREBASE_WEB_API_KEY;
  else process.env.FIREBASE_WEB_API_KEY = previousApiKey;
});

test('A1: a forged base64 JSON cookie is rejected; only firebase-admin verification is trusted', async () => {
  const forged = Buffer.from(JSON.stringify({user: {id: 'attacker', email: 'attacker@example.test', role: 'owner'}})).toString('base64url');
  globalThis.__testCookies = cookieStore({gymos_session: forged});
  const auth = await serverAuth();
  const {data} = await auth.auth.getUser();
  assert.equal(data.user, null);
  // The same forgery in the mobile cookie slot is rejected too.
  globalThis.__testCookies = cookieStore({'sb-token': forged});
  const again = await (await serverAuth()).auth.getUser();
  assert.equal(again.data.user, null);
});

test('A1: a verified session cookie identifies the user; an ID token works for mobile clients', async () => {
  globalThis.__testAuth.verifySessionCookie = async token => {
    assert.equal(token, 'good-cookie');
    return verifiedDecoded;
  };
  globalThis.__testCookies = cookieStore({gymos_session: 'good-cookie'});
  const {data} = await (await serverAuth()).auth.getUser();
  assert.equal(data.user.id, 'user-1');
  assert.equal(data.user.email, 'owner@example.test');

  globalThis.__testAuth.verifySessionCookie = async () => { throw Object.assign(new Error('not a cookie'), {code: 'auth/invalid-session-cookie'}); };
  globalThis.__testAuth.verifyIdToken = async token => {
    assert.equal(token, 'mobile-id-token');
    return verifiedDecoded;
  };
  globalThis.__testCookies = cookieStore({'sb-token': 'mobile-id-token'});
  const mobile = await (await serverAuth()).auth.getUser();
  assert.equal(mobile.data.user.id, 'user-1');
});

test('A2: sign-in with a wrong password fails and sets no cookie', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({error: {message: 'INVALID_PASSWORD'}}), {status: 400});
  const auth = await serverAuth();
  const result = await auth.auth.signInWithPassword({email: 'owner@example.test', password: 'wrong-password-1'});
  assert.equal(result.data.session, null);
  assert.ok(result.error);
  assert.equal(result.error.status, 401);
  assert.equal(globalThis.__testCookies.calls.set.length, 0, 'no session cookie may be set');
});

test('A2: provider throttling on sign-in maps to status 429', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({error: {message: 'TOO_MANY_ATTEMPTS_TRY_LATER'}}), {status: 429});
  const auth = await serverAuth();
  const result = await auth.auth.signInWithPassword({email: 'owner@example.test', password: 'x'.repeat(12)});
  assert.equal(result.error.status, 429);
});

test('A2: a correct password mints a 5-day httpOnly session cookie', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({idToken: 'firebase-id-token'}), {status: 200});
  globalThis.__testAuth.verifyIdToken = async () => verifiedDecoded;
  const auth = await serverAuth();
  const result = await auth.auth.signInWithPassword({email: 'owner@example.test', password: 'correct-horse-12'});
  assert.equal(result.error, null);
  assert.equal(result.data.session.access_token, 'minted-session-cookie');
  const set = globalThis.__testCookies.calls.set.find(c => c.name === 'gymos_session');
  assert.ok(set);
  assert.equal(set.options.httpOnly, true);
  assert.equal(set.options.sameSite, 'lax');
  assert.equal(set.options.maxAge, 60 * 60 * 24 * 5);
});

test('A3: a garbage confirmation code is rejected with 400 and no cookie', async () => {
  const auth = await serverAuth();
  const result = await auth.auth.exchangeCodeForSession('garbage');
  assert.equal(result.data.session, null);
  assert.equal(result.error.status, 400);
  assert.equal(globalThis.__testCookies.calls.set.length, 0);
});

test('A3: a genuine Firebase ID token is exchanged for a session cookie', async () => {
  globalThis.__testAuth.verifyIdToken = async token => {
    assert.equal(token, 'genuine-token');
    return verifiedDecoded;
  };
  const auth = await serverAuth();
  const result = await auth.auth.exchangeCodeForSession('genuine-token');
  assert.equal(result.error, null);
  assert.equal(result.data.session.access_token, 'minted-session-cookie');
  assert.equal(globalThis.__testCookies.calls.set.some(c => c.name === 'gymos_session'), true);
});

test('Password reset emails are really requested; existence is never revealed; 429 surfaces', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({url: String(url), body: JSON.parse(String(init.body))});
    return new Response(JSON.stringify({error: {message: 'EMAIL_NOT_FOUND'}}), {status: 400});
  };
  const auth = await serverAuth();
  const hidden = await auth.auth.resetPasswordForEmail('nobody@example.test');
  assert.equal(hidden.error, null, 'unknown accounts look identical to known ones');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes('accounts:sendOobCode'));
  assert.equal(calls[0].body.requestType, 'PASSWORD_RESET');

  globalThis.fetch = async () => new Response(JSON.stringify({error: {message: 'TOO_MANY_ATTEMPTS_TRY_LATER'}}), {status: 429});
  const limited = await (await serverAuth()).auth.resetPasswordForEmail('owner@example.test');
  assert.equal(limited.error.status, 429);
});

test('Password change requires a verified session, enforces 12+ characters, revokes other sessions', async () => {
  const updates = [];
  const revocations = [];
  globalThis.__testAuth.verifySessionCookie = async () => verifiedDecoded;
  globalThis.__testAuth.updateUser = async (uid, data) => { updates.push({uid, data}); };
  globalThis.__testAuth.revokeRefreshTokens = async uid => { revocations.push(uid); };
  globalThis.__testCookies = cookieStore({gymos_session: 'good-cookie'});

  const short = await (await serverAuth()).auth.updateUser({password: 'short'});
  assert.equal(short.error.status, 400);
  assert.equal(updates.length, 0);

  const ok = await (await serverAuth()).auth.updateUser({password: 'long-enough-password'});
  assert.equal(ok.error, null);
  assert.deepEqual(updates, [{uid: 'user-1', data: {password: 'long-enough-password'}}]);
  assert.deepEqual(revocations, ['user-1']);
  assert.ok(globalThis.__testCookies.calls.delete.includes('gymos_session'), 'session cookie cleared after password change');
});

test('Sign-out revokes refresh tokens globally and clears both cookies', async () => {
  const revocations = [];
  globalThis.__testAuth.verifySessionCookie = async () => verifiedDecoded;
  globalThis.__testAuth.revokeRefreshTokens = async uid => { revocations.push(uid); };
  globalThis.__testCookies = cookieStore({gymos_session: 'good-cookie', 'sb-token': 'mobile'});
  const {error} = await (await serverAuth()).auth.signOut({scope: 'global'});
  assert.equal(error, null);
  assert.deepEqual(revocations, ['user-1']);
  assert.deepEqual(globalThis.__testCookies.calls.delete.sort(), ['gymos_session', 'sb-token']);
});
