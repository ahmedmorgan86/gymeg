import {test} from 'node:test';
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

const { planSupabaseSessionRefresh } = await import('../app/lib/supabase-session-refresh.ts');
const { encodeSession } = await import('../app/lib/supabase-session-codec.ts');

const jwt = (exp) => ['h', Buffer.from(JSON.stringify({ exp })).toString('base64url'), 's'].join('.');
const env = { url: 'https://ref.supabase.co', key: 'sb_publishable_test' };

test('middleware refresh plan: keep fresh, rotate expired, clear dead, survive outages', async () => {
  const now = Date.now();
  // No cookie and undecodable cookie.
  assert.deepEqual(await planSupabaseSessionRefresh({ ...env, cookie: undefined }), { action: 'keep' });
  assert.deepEqual(await planSupabaseSessionRefresh({ ...env, cookie: 'not-a-session' }), { action: 'clear' });
  // Fresh access token: no provider call at all.
  global.fetch = async () => { throw new Error('must not be called'); };
  const fresh = encodeSession(jwt(Math.floor(now / 1000) + 3600), 'ref');
  assert.deepEqual(await planSupabaseSessionRefresh({ ...env, cookie: fresh, now }), { action: 'keep' });
  // Expired access token: rotated pair planned as a Set-Cookie.
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ access_token: jwt(Math.floor(now / 1000) + 3600), refresh_token: 'ref2' }) });
  const expired = encodeSession(jwt(Math.floor(now / 1000) - 10), 'ref');
  const rotated = await planSupabaseSessionRefresh({ ...env, cookie: expired, now });
  assert.equal(rotated.action, 'set');
  assert.ok(rotated.value.length <= 4000);
  // Dead refresh token clears; transient failure keeps (a concurrent request
  // may already have rotated).
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error_code: 'refresh_token_not_found' }) });
  assert.deepEqual(await planSupabaseSessionRefresh({ ...env, cookie: expired, now }), { action: 'clear' });
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  assert.deepEqual(await planSupabaseSessionRefresh({ ...env, cookie: expired, now }), { action: 'keep' });
  global.fetch = async () => { throw new Error('down'); };
  assert.deepEqual(await planSupabaseSessionRefresh({ ...env, cookie: expired, now }), { action: 'keep' });
  delete global.fetch;
});
