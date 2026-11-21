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
