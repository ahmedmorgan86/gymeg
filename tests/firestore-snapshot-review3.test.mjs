// REVIEW ROUND 3 (local only). Targets 593a949: precise per-op billed totals,
// concurrent initial scans, marker TTL/success-clearing, double-race fail-closed.
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

const { __counters, __reset, __store, __hooks } = await import('./firestore-snapshot-mock.mjs');
const { firestoreReadSpace, firestorePersistSpace, __clearSpaceCacheForTests } = await import('../app/lib/firestore-db.ts');

const OWNER = 'r3-owner';
const zero = () => { __counters.reads = 0; __counters.writes = 0; __counters.queries = 0; __counters.docsReturned = 0; };
const billed = () => __counters.reads + __counters.docsReturned;
const cold = () => { __clearSpaceCacheForTests(); return firestoreReadSpace(OWNER); };
const member = (i) => ({ id: randomUUID(), name: `عضو ${i}`, phone: `+20100${String(1000000+i).slice(-7)}`, branch: 'main' });
const withCap = async (cap, fn) => {
  const prev = process.env.GYMEG_MAX_SCAN_DOCS;
  process.env.GYMEG_MAX_SCAN_DOCS = String(cap);
  try { return await fn(); } finally { prev === undefined ? delete process.env.GYMEG_MAX_SCAN_DOCS : process.env.GYMEG_MAX_SCAN_DOCS = prev; }
};

beforeEach(async () => {
  __reset();
  const first = await firestoreReadSpace(OWNER);
  assert.equal(first.revision, 0);
  zero();
});

test('R3-1: precise billed total for a successful bootstrap scan (metadata + scan + recheck + backfill)', async () => {
  const base = await firestoreReadSpace(OWNER);
  const next = structuredClone(base.state);
  for (let i = 0; i < 150; i++) next.members.push(member(i));
  await firestorePersistSpace(OWNER, base, next);
  __store.get('gym_state_snapshots').clear(); // pre-snapshot revision
  zero();
  await cold();
  console.log(`R3-1: successful scan+bootstrap billed reads=${billed()} writes=${__counters.writes} (150 entity docs)`);
  // Components: state(1) + chunk0 miss(1) + marker miss(1) + entities 150 + photos 0 + recheck(1) = 155 reads; backfill tx = 1 read + ~2 writes
});

test('R3-2: tripped path billed total, then blocked path total', async () => {
  const base = await firestoreReadSpace(OWNER);
  const next = structuredClone(base.state);
  for (let i = 0; i < 150; i++) next.members.push(member(i));
  await firestorePersistSpace(OWNER, base, next);
  __store.get('gym_state_snapshots').clear();
  await withCap(100, async () => {
    zero();
    await assert.rejects(() => cold(), /scanBudget/);
    const tripCost = billed(); const tripWrites = __counters.writes;
    zero();
    await assert.rejects(() => cold(), /scanBudget/);
    console.log(`R3-2: trip billed=${tripCost} (+${tripWrites} marker write), blocked billed=${billed()} writes=${__counters.writes}`);
    assert.equal(billed(), 3, 'blocked attempt should cost exactly 3 reads (state + chunk0 + marker)');
    assert.equal(__counters.writes, 0, 'blocked attempt writes nothing');
  });
});

test('R3-3: concurrent initial cold reads BOTH scan (marker cannot prevent the first storm)', async () => {
  const base = await firestoreReadSpace(OWNER);
  const next = structuredClone(base.state);
  for (let i = 0; i < 150; i++) next.members.push(member(i));
  await firestorePersistSpace(OWNER, base, next);
  __store.get('gym_state_snapshots').clear();
  zero();
  __clearSpaceCacheForTests();
  const [a, b] = await Promise.all([firestoreReadSpace(OWNER), firestoreReadSpace(OWNER)]);
  console.log(`R3-3: two concurrent cold reads -> queries=${__counters.queries} docsReturned=${__counters.docsReturned} (2x scan = storm multiplication)`);
  assert.ok(__counters.docsReturned >= 300, 'both concurrent instances scanned (150 docs each)');
});

test('R3-4: marker TTL expiry allows a bounded retry scan; success clears the marker', async () => {
  const base = await firestoreReadSpace(OWNER);
  const next = structuredClone(base.state);
  for (let i = 0; i < 150; i++) next.members.push(member(i));
  await firestorePersistSpace(OWNER, base, next);
  __store.get('gym_state_snapshots').clear();
  await withCap(100, async () => {
    await assert.rejects(() => cold(), /scanBudget/); // trips, marker written
  });
  const marker = __store.get('gym_scan_guard').get(OWNER);
  assert.ok(marker, 'marker written');
  // age the marker past the 6h TTL
  __store.get('gym_scan_guard').set(OWNER, { ...marker, blockedAt: new Date(Date.now() - 7*3600*1000).toISOString() });
  const ok = await cold(); // cap back to default 2000: 150 docs fits
  assert.equal(ok.state.members.length, 150);
  assert.equal(__store.get('gym_scan_guard').has(OWNER), false, 'successful scan clears the marker');
  console.log('R3-4: TTL expiry -> bounded retry scan succeeds -> marker cleared');
});

test('R3-5: double race fails closed; nothing torn is served or cached', async () => {
  const base = await firestoreReadSpace(OWNER);
  const next = structuredClone(base.state);
  next.members.push(member(1), member(2));
  await firestorePersistSpace(OWNER, base, next);
  __store.get('gym_state_snapshots').clear();
  __clearSpaceCacheForTests();
  let bump = 100;
  __hooks.beforeQueryGet = (name) => {
    if (name !== 'gym_entities') return;
    const doc = __store.get('gym_states').get(OWNER);
    __store.get('gym_states').set(OWNER, { ...doc, revision: bump++ }); // bump on EVERY scan
  };
  try {
    await assert.rejects(() => firestoreReadSpace(OWNER), /raced concurrent writes/);
    console.log('R3-5: double race -> fail-closed error (not scanBudget, not torn state)');
  } finally { __hooks.beforeQueryGet = undefined; }
});

test('R3-6: worst-case request = scan + race + rescan stays under 2x(cap+4)', async () => {
  const base = await firestoreReadSpace(OWNER);
  const next = structuredClone(base.state);
  for (let i = 0; i < 150; i++) next.members.push(member(i));
  await firestorePersistSpace(OWNER, base, next);
  __store.get('gym_state_snapshots').clear();
  __hooks.beforeQueryGet = (name) => {
    if (name !== 'gym_entities') return;
    __hooks.beforeQueryGet = undefined; // race once only
    const doc = __store.get('gym_states').get(OWNER);
    __store.get('gym_states').set(OWNER, { ...doc, revision: 42 });
  };
  try {
    zero(); __clearSpaceCacheForTests();
    const r = await firestoreReadSpace(OWNER);
    assert.equal(r.revision, 42);
    console.log(`R3-6: single-race request billed=${billed()} (scan 150 + scan 150 + metadata)`);
  } finally { __hooks.beforeQueryGet = undefined; }
});
