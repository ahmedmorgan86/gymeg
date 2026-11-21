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
    if (url.endsWith('/app/lib/auth.ts')) return { format: 'module', shortCircuit: true, source: 'export const serverAuth=async()=>globalThis.__recoveryAuth;' };
    return next(url, context);
  }
});

const {GET} = await import('../app/auth/callback/recovery/route.ts');

let exchangeArgs;
beforeEach(() => {
  exchangeArgs = null;
  globalThis.__recoveryAuth = {
    auth: {
      verifyEmailToken: async (tokenHash, type) => tokenHash === 'genuine-hash' && type === 'recovery'
        ? {data: {session: {access_token: 'session'}}, error: null}
        : {data: {session: null}, error: {message: 'Invalid confirmation code', status: 400}},
      exchangeCodeForSession: async (code, opts) => {
        exchangeArgs = {code, opts};
        return code === 'genuine-code'
          ? {data: {session: {access_token: 'session'}}, error: null}
          : {data: {session: null}, error: {message: 'Invalid confirmation code', status: 400}};
      },
    },
  };
});

const PW = 'https://gym.example/auth/action?mode=resetPassword';
const FAIL = 'https://gym.example/sign-in?error=confirmation';

test('recovery PKCE code exchanges with the unconfirmed allowance and lands on the password form', async () => {
  const response = await GET(new Request('https://gym.example/auth/callback/recovery?code=genuine-code'));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), PW);
  assert.deepEqual(exchangeArgs, {code: 'genuine-code', opts: {allowUnconfirmed: true}});
});

test('recovery token_hash link lands on the password form', async () => {
  const response = await GET(new Request('https://gym.example/auth/callback/recovery?token_hash=genuine-hash&type=recovery'));
  assert.equal(response.headers.get('location'), PW);
});

test('a non-recovery token_hash type on the recovery path is refused', async () => {
  const response = await GET(new Request('https://gym.example/auth/callback/recovery?token_hash=genuine-hash&type=signup'));
  assert.equal(response.headers.get('location'), FAIL);
});

test('bad code and missing params fail to the confirmation error', async () => {
  assert.equal((await GET(new Request('https://gym.example/auth/callback/recovery?code=garbage'))).headers.get('location'), FAIL);
  assert.equal((await GET(new Request('https://gym.example/auth/callback/recovery'))).headers.get('location'), FAIL);
});
