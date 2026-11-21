import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';

const docId = key => createHash('sha256').update(key).digest('hex');

test('gymos.auth_rate_limits exists with RLS and supports the consume transaction', async () => {
  const db = await bootstrapDb({through: '20261121130000_auth_rate_limits.sql'});
  try {
    const table = (await db.query("SELECT relrowsecurity AS rls, relforcerowsecurity AS force FROM pg_class WHERE relname='auth_rate_limits' AND relnamespace='gymos'::regnamespace")).rows[0];
    assert.deepEqual(table, {rls: true, force: true});
    const policy = (await db.query("SELECT polname FROM pg_policy WHERE polrelid='gymos.auth_rate_limits'::regclass")).rows.map(r => r.polname);
    assert.deepEqual(policy, ['auth_rate_limits_app']);

    // Same transaction shape as consumePostgres in app/lib/auth-rate-limit.ts.
    const id = docId('session:login|ip:127.0.0.1|user@example.com');
    const resetAt = new Date(Date.now() + 900000).toISOString();
    await db.query('INSERT INTO gymos.auth_rate_limits(key_hash,hits,reset_at) VALUES($1,1,$2)', [id, resetAt]);
    await db.query('INSERT INTO gymos.auth_rate_limits(key_hash,hits,reset_at) VALUES($1,1,$2) ON CONFLICT(key_hash) DO UPDATE SET hits=1,reset_at=excluded.reset_at', [id, resetAt]);
    const row = (await db.query('SELECT hits FROM gymos.auth_rate_limits WHERE key_hash=$1 FOR UPDATE', [id])).rows[0];
    assert.equal(row.hits, 1);
    await db.query('UPDATE gymos.auth_rate_limits SET hits=$2 WHERE key_hash=$1', [id, row.hits + 1]);
    assert.equal((await db.query('SELECT hits FROM gymos.auth_rate_limits WHERE key_hash=$1', [id])).rows[0].hits, 2);
    await assert.rejects(() => db.query("INSERT INTO gymos.auth_rate_limits(key_hash,hits,reset_at) VALUES('not-a-hash',1,now())"), /check/i);
  } finally { await db.close(); }
});

test('store selection follows the persistence backend, not Firebase env presence', async () => {
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
});

test('a shared-store outage fails open, a healthy store enforces the limit', async () => {
  const { consumeWithStore } = await import('../app/lib/auth-rate-limit.ts');
  const now = Date.now();
  // Outage: Firestore path has no Firebase app in this process -> throws -> allowed.
  const outage = await consumeWithStore('firestore', 'scope|ip|e', 1, 60000, now);
  assert.deepEqual(outage, { allowed: true, retryAfter: 0 });
  // Healthy local store enforces: second hit over limit 1 is rejected.
  const first = await consumeWithStore(null, 't|ip|e', 1, 60000, now);
  const second = await consumeWithStore(null, 't|ip|e', 1, 60000, now);
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.ok(second.retryAfter >= 1);
});
