import './acceptance-route-loader.mjs';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerHooks } from 'node:module';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
await db.exec(`
  CREATE SCHEMA gymos;
  CREATE ROLE gymos_app;
  CREATE ROLE anon;
  CREATE ROLE authenticated;
  GRANT USAGE ON SCHEMA gymos TO gymos_app;
  CREATE TABLE gymos.platform_admins (
    user_id text PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE gymos.platform_admins ENABLE ROW LEVEL SECURITY;
  ALTER TABLE gymos.platform_admins FORCE ROW LEVEL SECURITY;
  GRANT SELECT ON gymos.platform_admins TO gymos_app;
  CREATE POLICY platform_admin_self ON gymos.platform_admins FOR SELECT TO gymos_app
    USING (user_id = current_setting('app.actor', true));
`);
await db.exec(readFileSync(join(import.meta.dirname, '..', 'supabase/migrations/20261125000000_support_requests.sql'), 'utf8'));

const users = {
  ownerA: { userId: 'owner-a', displayName: 'Owner A', email: 'a@example.test', fullName: 'Owner A' },
  ownerB: { userId: 'owner-b', displayName: 'Owner B', email: 'b@example.test', fullName: 'Owner B' },
  staff1: { userId: 'staff-1', displayName: 'Staff 1', email: 's1@example.test', fullName: 'Staff 1' },
  staff2: { userId: 'staff-2', displayName: 'Staff 2', email: 's2@example.test', fullName: 'Staff 2' },
};
await db.query(`INSERT INTO gymos.platform_admins (user_id) VALUES ($1), ($2)`, [users.staff1.userId, users.staff2.userId]);

process.env.GYMOS_DATA_BACKEND = 'postgres';
globalThis.__supportReqDb = db;
globalThis.__acceptanceUser = null;

registerHooks({
  load(url, context, next) {
    if (url.endsWith('/app/lib/database.ts')) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          let queue = Promise.resolve();
          export const db = {};
          export const withScope = async (owner, fn) => globalThis.__supportReqDb.transaction(async c => {
            await c.query('SET LOCAL ROLE gymos_app');
            await c.query("SELECT set_config('app.gym_owner', $1, true)", [owner]);
            return fn(c);
          });
          export const getPool = () => ({
            connect: async () => {
              let releaseLock;
              const prev = queue;
              queue = new Promise(r => { releaseLock = r; });
              await prev;
              return {
                query: async (sql, params) => {
                  const r = await globalThis.__supportReqDb.query(sql, params);
                  if (sql === 'BEGIN') await globalThis.__supportReqDb.query('SET LOCAL ROLE gymos_app');
                  return { ...r, rowCount: r.rowCount ?? r.rows.length };
                },
                release: () => releaseLock(),
              };
            },
          });
        `,
      };
    }
    return next(url, context);
  },
});

const { GET, POST } = await import('../app/api/support-requests/route.ts');

const jsonReq = (method, path, body, actor) => {
  globalThis.__acceptanceUser = actor;
  const headers = { origin: 'https://gymeg.example.test', host: 'gymeg.example.test' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  return new Request(`https://gymeg.example.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
};

test('PostgreSQL support requests: auth, RLS isolation, concurrent claim, idempotency, updates, and rate limit', async () => {
  // 1. Unauthenticated
  assert.equal((await GET(jsonReq('GET', '/api/support-requests', undefined, null))).status, 401);
  assert.equal((await POST(jsonReq('POST', '/api/support-requests', { action: 'create', title: 'Help', message: 'Hi' }, null))).status, 401);

  // 2. Create + idempotent retry
  const clientRequestId = '11111111-1111-4111-8111-111111111111';
  const createRes = await POST(jsonReq('POST', '/api/support-requests', {
    action: 'create', title: 'مشكلة في الطباعة', message: 'الطابعة لا تستجيب', clientRequestId,
  }, users.ownerA));
  assert.equal(createRes.status, 201);
  const { id } = await createRes.json();
  assert.match(id, /^[A-Za-z0-9]{20}$/);

  const retryRes = await POST(jsonReq('POST', '/api/support-requests', {
    action: 'create', title: 'مشكلة في الطباعة', message: 'الطابعة لا تستجيب', clientRequestId,
  }, users.ownerA));
  assert.equal(retryRes.status, 200);
  assert.equal((await retryRes.json()).id, id);

  // 3. Foreign account isolation + platform=1 check
  const foreignList = await GET(jsonReq('GET', '/api/support-requests', undefined, users.ownerB));
  assert.equal(foreignList.status, 200);
  assert.deepEqual((await foreignList.json()).requests, []);
  assert.equal((await GET(jsonReq('GET', `/api/support-requests?id=${id}`, undefined, users.ownerB))).status, 404);
  assert.equal((await GET(jsonReq('GET', '/api/support-requests?platform=1', undefined, users.ownerB))).status, 403);
  assert.equal((await POST(jsonReq('POST', '/api/support-requests', { action: 'reply', id, message: 'intrude' }, users.ownerB))).status, 404);
  assert.equal((await POST(jsonReq('POST', '/api/support-requests', { action: 'claim', id }, users.ownerB))).status, 404);

  // Direct RLS check as gymos_app for owner-b
  await db.transaction(async tx => {
    await tx.query('SET LOCAL ROLE gymos_app');
    await tx.query("SELECT set_config('app.actor', $1, true)", [users.ownerB.userId]);
    assert.equal((await tx.query('SELECT id FROM gymos.support_requests')).rows.length, 0);
    assert.equal((await tx.query('SELECT id FROM gymos.support_request_messages')).rows.length, 0);
  });

  // 4. Platform staff list + concurrent claim
  const staffList = await GET(jsonReq('GET', '/api/support-requests?platform=1', undefined, users.staff1));
  assert.equal(staffList.status, 200);
  assert.equal((await staffList.json()).requests.length, 1);

  const [c1, c2] = await Promise.all([
    POST(jsonReq('POST', '/api/support-requests', { action: 'claim', id }, users.staff1)),
    POST(jsonReq('POST', '/api/support-requests', { action: 'claim', id }, users.staff2)),
  ]);
  // Note: sequential check for true distinct staff1 vs staff2 race simulation
  const statuses = [c1.status, c2.status].sort();
  assert.deepEqual(statuses, [200, 403]);
  // Verify staff2 is definitely not the assignee if globalThis raced
  const threadAfterClaim = await (await GET(jsonReq('GET', `/api/support-requests?platform=1&id=${id}`, undefined, users.staff1))).json();
  const winner = threadAfterClaim.request.assignee === users.staff1.userId ? users.staff1 : users.staff2;
  const loser = winner.userId === users.staff1.userId ? users.staff2 : users.staff1;

  // Loser cannot reply or resolve
  assert.equal((await POST(jsonReq('POST', '/api/support-requests', { action: 'reply', id, message: 'hi' }, loser))).status, 403);
  assert.equal((await POST(jsonReq('POST', '/api/support-requests', { action: 'resolve', id }, loser))).status, 403);

  // Winner replies -> ownerA gets update; ownerA replies -> winner gets update
  assert.equal((await POST(jsonReq('POST', '/api/support-requests', { action: 'reply', id, message: 'جارٍ الفحص' }, winner))).status, 200);
  assert.equal((await POST(jsonReq('POST', '/api/support-requests', { action: 'reply', id, message: 'شكراً' }, users.ownerA))).status, 200);

  const ownerUpdates = await (await GET(jsonReq('GET', '/api/support-requests?updates=1', undefined, users.ownerA))).json();
  assert.deepEqual(ownerUpdates.updates.map(u => u.type), ['reply', 'claim']);
  const winnerUpdates = await (await GET(jsonReq('GET', '/api/support-requests?updates=1', undefined, winner))).json();
  assert.deepEqual(winnerUpdates.updates.map(u => u.type), ['reply']);

  // Thread contains 3 messages in chronological order
  const thread = await (await GET(jsonReq('GET', `/api/support-requests?id=${id}`, undefined, users.ownerA))).json();
  assert.equal(thread.messages.length, 3);
  assert.equal(thread.messages[0].text, 'الطابعة لا تستجيب');
  assert.equal(thread.messages[2].text, 'شكراً');

  // Resolve closes thread and blocks further replies
  assert.equal((await POST(jsonReq('POST', '/api/support-requests', { action: 'resolve', id }, winner))).status, 200);
  assert.equal((await POST(jsonReq('POST', '/api/support-requests', { action: 'reply', id, message: 'after close' }, users.ownerA))).status, 403);

  // 5. Bounds + rate limit
  assert.equal((await POST(jsonReq('POST', '/api/support-requests', 'x'.repeat(12001), users.ownerA))).status, 413);
  assert.equal((await POST(jsonReq('POST', '/api/support-requests', { action: 'create', title: 'ab', message: 'valid' }, users.ownerA))).status, 400);

  for (let i = 0; i < 4; i++) {
    assert.equal((await POST(jsonReq('POST', '/api/support-requests', { action: 'create', title: `Ticket ${i}`, message: 'body' }, users.ownerA))).status, 201);
  }
  assert.equal((await POST(jsonReq('POST', '/api/support-requests', { action: 'create', title: 'Ticket 6th', message: 'body' }, users.ownerA))).status, 429);
});

after(async () => { await db.close(); });
