// Operator bootstrap script: exercised OFFLINE against the read-counting
// mock so the script's first execution is not production. Covers dry-run,
// missing count aggregation, over-budget refusal, partial failure across
// owners, and clearing of a tripped durable scan-guard marker.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'firebase-admin/app' || spec === 'firebase-admin/firestore') {
      return { url: new URL('./firestore-snapshot-mock.mjs', import.meta.url).href, shortCircuit: true };
    }
    return next(spec, ctx);
  },
});

process.env.GYMEG_FIREBASE_PROJECT_ID = 'test-project';
process.env.GYMEG_MEMBER_PIN_KEY = randomBytes(32).toString('base64');

const { __counters, __reset, __store } = await import('./firestore-snapshot-mock.mjs');
const { firestoreReadSpace, firestorePersistSpace, __clearSpaceCacheForTests } = await import('../app/lib/firestore-db.ts');
const { runBackfill } = await import('../scripts/backfill-snapshots.mjs');

const OWNER = 'bf-owner';
const OTHER = 'bf-other';
const member = (i) => ({ id: randomUUID(), name: `عضو ${i}`, phone: `+20100${String(1000000 + i).slice(-7)}`, branch: 'main' });
const logs = [];
const log = (m) => logs.push(m);
const warn = (m) => logs.push(`WARN ${m}`);

async function seed(owner, members) {
  const base = await firestoreReadSpace(owner);
  const next = structuredClone(base.state);
  for (let index = 0; index < members; index++) next.members.push(member(index));
  assert.equal(await firestorePersistSpace(owner, base, next), true);
  __store.get('gym_state_snapshots').clear(); // pre-snapshot club
  __clearSpaceCacheForTests();
}

beforeEach(async () => {
  __reset();
  logs.length = 0;
  delete process.env.GYMEG_MAX_SCAN_DOCS;
  delete process.env.GYMEG_MOCK_DISABLE_COUNT;
});

test('refuses to run without an explicit budget', async () => {
  await assert.rejects(() => runBackfill([OWNER], { log, warn }), /GYMEG_MAX_SCAN_DOCS/);
});

test('dry-run counts via aggregation and writes nothing', async () => {
  await seed(OWNER, 150);
  process.env.GYMEG_MAX_SCAN_DOCS = '500';
  const writesBefore = __counters.writes;
  const readsBefore = __counters.reads;
  await runBackfill([OWNER, '--dry-run'], { log, warn });
  assert.ok(logs.some(m => m.includes('150 entity docs')), logs.join(' | '));
  assert.equal(__counters.writes, writesBefore, 'dry-run must not write');
  assert.equal((__store.get('gym_state_snapshots') ?? new Map()).size, 0, 'dry-run must not snapshot');
  const billed = __counters.reads - readsBefore;
  assert.ok(billed <= 2, `aggregation counting billed ${billed} reads`);
});

test('missing count aggregation: warns and still bootstraps', async () => {
  await seed(OWNER, 150);
  process.env.GYMEG_MAX_SCAN_DOCS = '500';
  process.env.GYMEG_MOCK_DISABLE_COUNT = '1';
  await runBackfill([OWNER], { log, warn });
  assert.ok(logs.some(m => m.startsWith('WARN') && m.includes('count aggregation unavailable')), logs.join(' | '));
  assert.ok((__store.get('gym_state_snapshots') ?? new Map()).size >= 1, 'snapshot written despite missing aggregation');
});

test('over-budget club fails closed and is reported as failed', async () => {
  await seed(OWNER, 150);
  process.env.GYMEG_MAX_SCAN_DOCS = '100'; // floor; 150 entity docs exceed it
  await assert.rejects(() => runBackfill([OWNER], { log, warn }), /1 of 1 owners failed/);
  assert.equal((__store.get('gym_state_snapshots') ?? new Map()).size, 0, 'no snapshot for over-budget club');
});

test('partial failure: other owners still bootstrap; exit reports the failures', async () => {
  await seed(OWNER, 150);   // fits budget 500
  await seed(OTHER, 300);   // fits 500 too... make it over by lowering per-owner? no: use budget 200
  process.env.GYMEG_MAX_SCAN_DOCS = '200'; // OWNER(150) fits, OTHER(300) fails
  await assert.rejects(() => runBackfill([OWNER, OTHER], { log, warn }), /1 of 2 owners failed: bf-other/);
  const snaps = __store.get('gym_state_snapshots') ?? new Map();
  assert.ok([...snaps.keys()].some(k => k.startsWith(`${OWNER}_`)), 'first owner bootstrapped');
  assert.ok(![...snaps.keys()].some(k => k.startsWith(`${OTHER}_`)), 'second owner not bootstrapped');
});

test('bootstrap clears a tripped durable scan-guard marker', async () => {
  await seed(OWNER, 150);
  // Trip the guard with a tiny in-app cap.
  process.env.GYMEG_MAX_SCAN_DOCS = '100';
  await assert.rejects(() => firestoreReadSpace(OWNER), /scanBudget/);
  assert.ok((__store.get('gym_scan_guard') ?? new Map()).has(OWNER), 'marker written by the trip');
  // Operator bootstrap with a deliberate budget: not blocked, marker cleared.
  process.env.GYMEG_MAX_SCAN_DOCS = '500';
  __clearSpaceCacheForTests();
  await runBackfill([OWNER], { log, warn });
  assert.equal((__store.get('gym_scan_guard') ?? new Map()).has(OWNER), false, 'marker cleared by successful bootstrap');
  assert.ok((__store.get('gym_state_snapshots') ?? new Map()).size >= 1, 'snapshot written');
  // And the in-app default guard now serves from the snapshot query-free.
  delete process.env.GYMEG_MAX_SCAN_DOCS;
  __clearSpaceCacheForTests();
  const before = __counters.queries;
  const read = await firestoreReadSpace(OWNER);
  assert.equal(read.state.members.length, 150);
  assert.equal(__counters.queries - before, 0, 'post-bootstrap cold read is query-free');
});
