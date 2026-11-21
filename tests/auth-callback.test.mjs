import {test, beforeEach} from 'node:test';
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
    if (url.endsWith('/app/lib/auth.ts')) return { format: 'module', shortCircuit: true, source: 'export const serverAuth=async()=>globalThis.__callbackAuth;' };
    return next(url, context);
  }
});

const {GET} = await import('../app/auth/callback/route.ts');

beforeEach(() => {
  globalThis.__callbackAuth = {
    auth: {
      exchangeCodeForSession: async code => code === 'genuine-token'
        ? {data: {session: {access_token: 'session'}}, error: null}
        : {data: {session: null}, error: {message: 'Invalid confirmation code', status: 400}},
      verifyEmailToken: async (tokenHash, type) => tokenHash === 'genuine-hash'
        ? {data: {session: {access_token: 'session'}}, error: null}
        : {data: {session: null}, error: {message: 'Invalid confirmation code', status: 400}},
    },
  };
});

test('A3: GET /auth/callback?code=garbage redirects to /sign-in?error=confirmation and sets no cookie', async () => {
  const response = await GET(new Request('https://gym.example/auth/callback?code=garbage'));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), 'https://gym.example/sign-in?error=confirmation');
  assert.equal(response.headers.get('set-cookie'), null);
});

test('A3: a missing code redirects to the confirmation error as well', async () => {
  const response = await GET(new Request('https://gym.example/auth/callback'));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), 'https://gym.example/sign-in?error=confirmation');
});

test('A3: a genuine token establishes the session and lands on /clubs', async () => {
  const response = await GET(new Request('https://gym.example/auth/callback?code=genuine-token'));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), 'https://gym.example/clubs');
});

test('A3: a token_hash recovery link lands on the new-password page, not /clubs', async () => {
  const response = await GET(new Request('https://gym.example/auth/callback?token_hash=genuine-hash&type=recovery'));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), 'https://gym.example/auth/action?mode=resetPassword');
});

test('A3: a token_hash signup confirmation lands signed-in on /clubs', async () => {
  const response = await GET(new Request('https://gym.example/auth/callback?token_hash=genuine-hash&type=signup'));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), 'https://gym.example/clubs');
});

test('A3: an invalid token_hash redirects to the confirmation error', async () => {
  const response = await GET(new Request('https://gym.example/auth/callback?token_hash=garbage&type=recovery'));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), 'https://gym.example/sign-in?error=confirmation');
});
