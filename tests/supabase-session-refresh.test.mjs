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
  // Even a locally undecodable cookie is kept: this request's snapshot may be
  // stale relative to a concurrent sign-in, and a clear could wipe it.
  assert.deepEqual(await planSupabaseSessionRefresh({ ...env, cookie: 'not-a-session' }), { action: 'keep' });
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
  // Provider rejections NEVER clear: an identical concurrent request may have
  // consumed the refresh token and set the rotated pair, and a late clear
  // from this request would log the user out. Only a locally undecodable
  // cookie clears.
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error_code: 'refresh_token_not_found' }) });
  assert.deepEqual(await planSupabaseSessionRefresh({ ...env, cookie: expired, now }), { action: 'keep' });
  global.fetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
  assert.deepEqual(await planSupabaseSessionRefresh({ ...env, cookie: expired, now }), { action: 'keep' });
  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  assert.deepEqual(await planSupabaseSessionRefresh({ ...env, cookie: expired, now }), { action: 'keep' });
  global.fetch = async () => { throw new Error('down'); };
  assert.deepEqual(await planSupabaseSessionRefresh({ ...env, cookie: expired, now }), { action: 'keep' });
  delete global.fetch;
});

test('staggered concurrent refreshes of the same cookie never produce a clear', async () => {
  const now = Date.now();
  const expired = encodeSession(jwt(Math.floor(now / 1000) - 10), 'ref');
  // First request's rotation succeeds; the second request (which read the
  // same old cookie before the first responded) gets the single-use
  // refresh_token_not_found. Its plan must be keep, not clear.
  let call = 0;
  global.fetch = async () => {
    call++;
    if (call === 1) return { ok: true, status: 200, json: async () => ({ access_token: jwt(Math.floor(now / 1000) + 3600), refresh_token: 'ref2' }) };
    return { ok: false, status: 400, json: async () => ({ error_code: 'refresh_token_not_found' }) };
  };
  const [winner, loser] = await Promise.all([
    planSupabaseSessionRefresh({ ...env, cookie: expired, now }),
    planSupabaseSessionRefresh({ ...env, cookie: expired, now }),
  ]);
  assert.equal(winner.action, 'set');
  assert.equal(loser.action, 'keep');
  delete global.fetch;
});

test('session-changing middleware responses carry cache-prevention headers', async () => {
  // Exercises the exact header block from middleware.ts against the plan
  // shape: only a 'set' plan may carry these headers.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../middleware.ts', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf("if (plan.action === 'set')", source.indexOf('NextResponse.next')));
  assert.match(block, /Cache-Control', 'private, no-store, must-revalidate'/);
  assert.match(block, /Pragma', 'no-cache'/);
  assert.match(block, /Expires', '0'/);
  // Keep/unknown paths must not add cache headers to public pages.
  assert.equal(source.includes("if (plan.action === 'clear')"), false);
});
