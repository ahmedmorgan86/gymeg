import {test, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

// Real-behavior tests for the Next 16 proxy: it executes in the Node
// runtime, so the real module and the real NextResponse run here.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { url: 'data:text/javascript,export{}', shortCircuit: true };
    // The real NextResponse, resolved to its CJS file because next's exports
    // map does not expose ./server to plain ESM imports outside a Next build.
    if (specifier === 'next/server') return { url: new URL('../node_modules/next/server.js', import.meta.url).href, shortCircuit: true };
    try { return next(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context);
      throw error;
    }
  },
});

const {proxy} = await import('../proxy.ts');
const {encodeSession} = await import('../app/lib/supabase-session-codec.ts');

const ROBOTS = 'noindex, nofollow, noarchive';
const STRONG = 'private, no-store, must-revalidate';

function fakeJwt(expSeconds) {
  const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return part({ alg: 'none' }) + '.' + part({ exp: expSeconds }) + '.sig';
}

function req(pathname, { method = 'GET', cookies = {} } = {}) {
  const jar = new Map(Object.entries(cookies));
  return {
    method,
    nextUrl: { pathname },
    cookies: {
      has: (n) => jar.has(n),
      get: (n) => (jar.has(n) ? { value: jar.get(n) } : undefined),
      set: (n, v) => { jar.set(n, v); },
    },
    _jar: jar,
  };
}

let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  process.env.GYMOS_AUTH_BACKEND = 'supabase';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://ref.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
});
afterEach(() => {
  process.env = savedEnv;
  delete global.fetch;
});

test('marketing page, no session: no robots header, no cache policy, no cookie', async () => {
  const response = await proxy(req('/about'));
  assert.equal(response.headers.get('X-Robots-Tag'), null);
  assert.equal(response.headers.get('Cache-Control'), null);
  assert.equal(response.headers.get('set-cookie'), null);
});

test('protected page, no refresh: robots + private no-store, no session write', async () => {
  const response = await proxy(req('/clubs'));
  assert.equal(response.headers.get('X-Robots-Tag'), ROBOTS);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('set-cookie'), null);
});

test('protected page WITH refresh keeps robots and upgrades to strong no-store', async () => {
  const soon = Math.floor(Date.now() / 1000) + 30;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ access_token: fakeJwt(soon + 3600), refresh_token: 'new-refresh' }) });
  const response = await proxy(req('/clubs', { cookies: { gymos_session: encodeSession(fakeJwt(soon), 'old-refresh') } }));
  assert.equal(response.headers.get('X-Robots-Tag'), ROBOTS);
  assert.equal(response.headers.get('Cache-Control'), STRONG);
  assert.equal(response.headers.get('Pragma'), 'no-cache');
  assert.equal(response.headers.get('Expires'), '0');
  assert.match(response.headers.get('set-cookie') || '', /gymos_session=/);
});

test('root stays indexable even while a refresh happens', async () => {
  const soon = Math.floor(Date.now() / 1000) + 30;
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ access_token: fakeJwt(soon + 3600), refresh_token: 'new-refresh' }) });
  const response = await proxy(req('/', { cookies: { gymos_session: encodeSession(fakeJwt(soon), 'old-refresh') } }));
  assert.equal(response.headers.get('X-Robots-Tag'), null);
  assert.equal(response.headers.get('Cache-Control'), STRONG);
});

test('support write-block returns 403 before any provider fetch; commercial API exempt', async () => {
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; throw new Error('nope'); };
  const blocked = await proxy(req('/api/member', { method: 'POST', cookies: { 'gymos-support': '1' } }));
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers.get('Cache-Control'), 'no-store');
  assert.equal(fetchCalled, false);
  const allowed = await proxy(req('/api/commercial', { method: 'POST', cookies: { 'gymos-support': '1' } }));
  assert.notEqual(allowed.status, 403);
});

test('firebase backend skips the refresh plan entirely', async () => {
  process.env.GYMOS_AUTH_BACKEND = 'firebase';
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; throw new Error('nope'); };
  const soon = Math.floor(Date.now() / 1000) + 30;
  const response = await proxy(req('/clubs', { cookies: { gymos_session: encodeSession(fakeJwt(soon), 'old-refresh') } }));
  assert.equal(fetchCalled, false);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('X-Robots-Tag'), ROBOTS);
});
