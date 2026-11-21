import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';

registerHooks({
  resolve(specifier, context, next) {
    // Route the limiter's lazy database.ts import to the PGlite-backed stub so
    // tests exercise the actual consumePostgres code path, not copied SQL.
    if (specifier === './database.ts' && context.parentURL?.endsWith('app/lib/auth-rate-limit.ts')) {
      return next(new URL('./stubs/database-pglite.mjs', import.meta.url).href, context);
    }
    try { return next(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context);
      throw error;
    }
  },
});

test('gymos.auth_rate_limits exists with forced RLS and an app-only policy', async () => {
  const db = await bootstrapDb({through: '20261121130000_auth_rate_limits.sql'});
  try {
    const table = (await db.query("SELECT relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class WHERE relname='auth_rate_limits' AND relnamespace='gymos'::regnamespace")).rows[0];
    assert.deepEqual(table, {rls: true, force: true});
    const policy = (await db.query("SELECT polname FROM pg_policy WHERE polrelid='gymos.auth_rate_limits'::regclass")).rows.map(r => r.polname);
    assert.deepEqual(policy, ['auth_rate_limits_app']);
    await assert.rejects(() => db.query("INSERT INTO gymos.auth_rate_limits(key_hash,hits,reset_at) VALUES('not-a-hash',1,now())"), /check/i);
  } finally { await db.close(); }
});

test('store selection is strict: typos and missing required config fail closed', async () => {
  const { rateLimitStoreFor } = await import('../app/lib/auth-rate-limit.ts');
  const firebase = { GYMEG_FIREBASE_SERVICE_ACCOUNT: '{}' };
  // Legacy production: Firebase envs, no override -> Firestore counters.
  assert.equal(rateLimitStoreFor({ ...firebase }), 'firestore');
  // Fresh build: Firebase envs stay for FCM push, data backend is Postgres.
  assert.equal(rateLimitStoreFor({ ...firebase, GYMOS_DATA_BACKEND: 'postgres', DATABASE_URL: 'postgres://x' }), 'postgres');
  // Pure Postgres deployment without any Firebase env.
  assert.equal(rateLimitStoreFor({ DATABASE_URL: 'postgres://x' }), 'postgres');
  // No shared store available -> per-process Map.
  assert.equal(rateLimitStoreFor({}), 'local');
  // Tests never touch shared stores.
  assert.equal(rateLimitStoreFor({ ...firebase, NODE_ENV: 'test' }), 'local');
  // A typo must throw, never silently fall back to Firestore or local.
  assert.throws(() => rateLimitStoreFor({ ...firebase, GYMOS_DATA_BACKEND: 'postgre' }), /GYMOS_DATA_BACKEND/);
  assert.throws(() => rateLimitStoreFor({ ...firebase, GYMOS_DATA_BACKEND: 'firestore' }), /GYMOS_DATA_BACKEND/);
  // Explicit Postgres without DATABASE_URL: local Map is acceptable in
  // development, never in production.
  assert.equal(rateLimitStoreFor({ GYMOS_DATA_BACKEND: 'postgres' }), 'local');
  assert.throws(() => rateLimitStoreFor({ GYMOS_DATA_BACKEND: 'postgres', NODE_ENV: 'production' }), /DATABASE_URL/);
});

test('a shared-store outage fails closed and retryable, a healthy store enforces the limit', async () => {
  const { consumeWithStore } = await import('../app/lib/auth-rate-limit.ts');
  const now = Date.now();
  // Outage: Firestore path has no Firebase app in this process -> throws ->
  // retryable denial (routes answer 503), never an unconditional allowance.
  const outage = await consumeWithStore('firestore', 'scope|ip|e', 1, 60000, now);
  assert.equal(outage.allowed, false);
  assert.equal(outage.outage, true);
  assert.ok(outage.retryAfter >= 1);
  // Healthy local store enforces: second hit over limit 1 is rejected.
  const first = await consumeWithStore(null, 't|ip|e', 1, 60000, now);
  const second = await consumeWithStore(null, 't|ip|e', 1, 60000, now);
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.ok(second.retryAfter >= 1);
});

test('consumePostgres runs against a real database: first window, rollover, and roles', async () => {
  const db = await bootstrapDb({through: '20261121130000_auth_rate_limits.sql'});
  const { __setDb } = await import('./stubs/database-pglite.mjs');
  __setDb(db);
  const { consumeWithStore } = await import('../app/lib/auth-rate-limit.ts');
  const now = Date.now();
  try {
    // First window: two consumes with limit 1 -> exactly one allowed, and the
    // stored counter shows both hits (no concurrent-insert reset loss).
    const first = await consumeWithStore('postgres', 'w|ip|e', 1, 60000, now);
    const second = await consumeWithStore('postgres', 'w|ip|e', 1, 60000, now);
    assert.equal(first.allowed, true);
    assert.equal(second.allowed, false);
    assert.ok(second.retryAfter >= 1);
    const stored = await db.query("SELECT hits FROM gymos.auth_rate_limits WHERE key_hash=(SELECT key_hash FROM gymos.auth_rate_limits LIMIT 1)");
    assert.equal(stored.rows[0].hits, 2);

    // Rollover: once the stored window expires, the counter restarts at 1.
    const rolled = await consumeWithStore('postgres', 'w|ip|e', 1, 60000, now + 120000);
    assert.equal(rolled.allowed, true);
    const afterRoll = await db.query('SELECT hits FROM gymos.auth_rate_limits');
    assert.equal(afterRoll.rows[0].hits, 1);

    // Runtime role: gymos_app consumes through the RLS policy.
    await db.query('SET ROLE gymos_app');
    const asApp = await consumeWithStore('postgres', 'role|ip|e', 5, 60000, now);
    assert.equal(asApp.allowed, true);
    await db.query('RESET ROLE');

    // anon and authenticated have no table privileges at all.
    for (const role of ['anon', 'authenticated']) {
      await db.query(`SET ROLE ${role}`);
      await assert.rejects(
        () => db.query("INSERT INTO gymos.auth_rate_limits(key_hash,hits,reset_at) VALUES(repeat('a',64),1,now())"),
        /permission denied/,
      );
      await db.query('RESET ROLE');
    }
  } finally {
    __setDb(null);
    await db.close();
  }
});

test('consumeAuthRateLimit aggregation preserves outage for route 503 mapping', async () => {
  process.env.GYMEG_FIREBASE_SERVICE_ACCOUNT = '{}';
  try {
    const { consumeAuthRateLimit } = await import('../app/lib/auth-rate-limit.ts');
    // Firestore store selected but no Firebase app exists in this process, so
    // the shared store throws inside real aggregation — exactly what a route
    // sees during a counter-store outage.
    const request = new Request('https://app.test/api/session', { headers: { 'x-forwarded-for': '203.0.113.9' } });
    const decision = await consumeAuthRateLimit('session:login', request, 'user@example.com', 10);
    assert.equal(decision.allowed, false);
    assert.equal(decision.outage, true);
    assert.ok(decision.retryAfter >= 1);
  } finally {
    delete process.env.GYMEG_FIREBASE_SERVICE_ACCOUNT;
  }
});
