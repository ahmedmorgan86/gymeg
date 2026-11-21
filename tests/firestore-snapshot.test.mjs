// Revision-snapshot read path: proves with a mocked, read-counting Firestore
// that cold reads after a persist cost a handful of document reads instead of
// a full entity scan, that snapshots never serve a stale revision, and that
// the legacy entity-scan fallback still works. No real database is touched.
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
const { emptyState } = await import('../app/lib/domain.ts');

const OWNER = 'test-owner';
const zeroCounters = () => { __counters.reads = 0; __counters.writes = 0; __counters.queries = 0; __counters.docsReturned = 0; };
const coldRead = async () => {
  __clearSpaceCacheForTests();
  zeroCounters();
  return firestoreReadSpace(OWNER);
};

const seedSpace = async () => {
  __reset();
  const first = await firestoreReadSpace(OWNER); // creates revision 0
  assert.equal(first.revision, 0);
  return first;
};

const member = (index, photo) => ({
  id: randomUUID(),
  name: `عضو اختبار ${index} ${randomUUID()}`,
  phone: `+20100${String(1000000 + index).slice(-7)}`,
  branch: 'main',
  ...(photo ? { photo } : {}),
});

beforeEach(async () => {
  await seedSpace();
});

test('cold read after persist costs a few document reads and never queries the entity store', async () => {
  const base = await firestoreReadSpace(OWNER);
  const next = structuredClone(base.state);
  next.settings.name = 'نادي الاختبار';
  assert.equal(await firestorePersistSpace(OWNER, base, next), true);

  const cold = await coldRead();
  assert.equal(cold.revision, 1);
  assert.equal(cold.state.settings.name, 'نادي الاختبار');
  // 1 state-document read + 1 snapshot-chunk read; crucially zero query scans.
  assert.equal(__counters.queries, 0);
  assert.ok(__counters.reads <= 3, `cold read used ${__counters.reads} document reads`);
});

test('warm read costs one revision document read', async () => {
  const base = await firestoreReadSpace(OWNER);
  await firestorePersistSpace(OWNER, base, base.state);
  await firestoreReadSpace(OWNER); // warms the instance cache
  zeroCounters();
  const warm = await firestoreReadSpace(OWNER);
  assert.equal(warm.revision, 1);
  assert.equal(__counters.reads, 1);
  assert.equal(__counters.queries, 0);
});

test('multi-chunk snapshot round-trips a large state with photos intact', async () => {
  const base = await firestoreReadSpace(OWNER);
  const big = structuredClone(base.state);
  const photos = new Map();
  for (let index = 0; index < 60; index++) {
    const photo = randomBytes(45_000).toString('base64'); // ~60KB, incompressible
    const m = member(index, photo);
    photos.set(m.id, photo);
    big.members.push(m);
  }
  // Photos are excluded from the snapshot (they live in gym_photos docs), so
  // force multiple chunks with large non-photo state instead.
  big.settings.notes = randomBytes(900_000).toString('base64'); // ~1.2MB, incompressible
  assert.equal(await firestorePersistSpace(OWNER, base, big), true);

  const chunks = __store.get('gym_state_snapshots') ?? new Map();
  const chunkCount = chunks.get(`${OWNER}_0`)?.chunks;
  assert.ok(chunkCount > 1, `expected a multi-chunk snapshot, got ${chunkCount}`);
  assert.equal(chunks.size, chunkCount);
  // Snapshot bytes must not carry the photo payloads.
  const snapshotBytes = [...chunks.values()].reduce((sum, doc) => sum + doc.data.length, 0);
  assert.ok(snapshotBytes < 3_000_000, `snapshot duplicated photo bytes (${snapshotBytes})`);

  const cold = await coldRead();
  assert.equal(cold.revision, 1);
  assert.equal(cold.state.members.length, 60);
  for (const [id, photo] of photos) {
    assert.equal(cold.state.members.find(m => m.id === id)?.photo, photo);
  }
  // 1 state doc + 1 read per chunk + 1 read per photo + 1 revision re-check
  // (photo path only), still no entity scan.
  assert.equal(__counters.queries, 0);
  assert.equal(__counters.reads, 1 + chunkCount + 60 + 1);

  // GC: shrinking back below the chunk count deletes the extra chunks.
  const shrunk = structuredClone(cold.state);
  delete shrunk.settings.notes;
  assert.equal(await firestorePersistSpace(OWNER, cold, shrunk), true);
  const afterChunks = __store.get('gym_state_snapshots') ?? new Map();
  assert.equal(afterChunks.get(`${OWNER}_0`)?.chunks, 1);
  assert.equal(afterChunks.size, 1);
  const stateDoc = __store.get('gym_states').get(OWNER);
  assert.equal(stateDoc._snapshotChunks, 1);
});

test('missing snapshot falls back to the legacy entity scan and stays correct', async () => {
  const base = await firestoreReadSpace(OWNER);
  const next = structuredClone(base.state);
  next.members.push(member(1), member(2));
  assert.equal(await firestorePersistSpace(OWNER, base, next), true);
  // Simulate a revision written before snapshots existed.
  __store.get('gym_state_snapshots').clear();

  const cold = await coldRead();
  assert.equal(cold.revision, 1);
  assert.equal(cold.state.members.length, 2);
  assert.ok(__counters.queries >= 1, 'expected the entity scan to run');
});

test('a snapshot from an older revision is never served', async () => {
  const base = await firestoreReadSpace(OWNER);
  const next = structuredClone(base.state);
  next.settings.name = 'revision one';
  assert.equal(await firestorePersistSpace(OWNER, base, next), true);
  // Advance the state document behind the snapshot's back (impossible via the
  // app, possible via a failed external write): the reader must not serve the
  // stale snapshot.
  const stateDoc = __store.get('gym_states').get(OWNER);
  const metadata = JSON.parse(stateDoc.payload);
  metadata.name = 'advanced outside';
  __store.get('gym_states').set(OWNER, { ...stateDoc, revision: 2 });

  const cold = await coldRead();
  assert.equal(cold.revision, 2);
  assert.ok(__counters.queries >= 1, 'expected fallback to the entity scan on revision mismatch');
});

test('fallback scan backfills a snapshot; the next cold read is cheap', async () => {
  const base = await firestoreReadSpace(OWNER);
  const next = structuredClone(base.state);
  next.members.push(member(1), member(2));
  assert.equal(await firestorePersistSpace(OWNER, base, next), true);
  __store.get('gym_state_snapshots').clear(); // simulate a pre-snapshot revision

  const first = await coldRead(); // scans once, then backfills
  assert.equal(first.state.members.length, 2);
  assert.ok(__counters.docsReturned >= 2, 'expected the one-time scan');
  assert.ok((__store.get('gym_state_snapshots') ?? new Map()).size >= 1, 'expected a backfilled snapshot');

  const second = await coldRead();
  assert.equal(second.state.members.length, 2);
  assert.equal(__counters.queries, 0, 'second cold read must not scan');
  assert.ok(__counters.reads <= 3, `second cold read used ${__counters.reads} reads`);
});

test('the scan circuit breaker fails closed instead of burning quota', async () => {
  const base = await firestoreReadSpace(OWNER);
  const next = structuredClone(base.state);
  for (let index = 0; index < 150; index++) next.members.push(member(index));
  assert.equal(await firestorePersistSpace(OWNER, base, next), true);
  __store.get('gym_state_snapshots').clear();
  const previous = process.env.GYMEG_MAX_SCAN_DOCS;
  process.env.GYMEG_MAX_SCAN_DOCS = '200'; // 150 members + photos stay under
  try {
    __clearSpaceCacheForTests();
    const fine = await firestoreReadSpace(OWNER);
    assert.equal(fine.state.members.length, 150);

    process.env.GYMEG_MAX_SCAN_DOCS = '100'; // the code floor; 150 entity docs exceed it
    __store.get('gym_state_snapshots').clear(); // drop the backfill too
    __clearSpaceCacheForTests();
    await assert.rejects(() => firestoreReadSpace(OWNER), /scanBudget/);
    // Partial state is never served: the read throws before assembly.
  } finally {
    if (previous === undefined) delete process.env.GYMEG_MAX_SCAN_DOCS; else process.env.GYMEG_MAX_SCAN_DOCS = previous;
  }
});

test('snapshots are isolated per owner', async () => {
  const base = await firestoreReadSpace(OWNER);
  const next = structuredClone(base.state);
  next.settings.name = 'owner one';
  assert.equal(await firestorePersistSpace(OWNER, base, next), true);

  const OTHER = 'other-owner';
  const otherBase = await firestoreReadSpace(OTHER);
  const otherNext = structuredClone(otherBase.state);
  otherNext.settings.name = 'owner two';
  assert.equal(await firestorePersistSpace(OTHER, otherBase, otherNext), true);

  __clearSpaceCacheForTests();
  const one = await firestoreReadSpace(OWNER);
  const two = await firestoreReadSpace(OTHER);
  assert.equal(one.state.settings.name, 'owner one');
  assert.equal(two.state.settings.name, 'owner two');
  const snapshotIds = [...(__store.get('gym_state_snapshots') ?? new Map()).keys()];
  assert.ok(snapshotIds.every(id => id.startsWith(`${OWNER}_`) || id.startsWith(`${OTHER}_`)));
});

test('a 10k-document club cold-reads with a handful of document reads', async () => {
  const base = await firestoreReadSpace(OWNER);
  const big = structuredClone(base.state);
  for (let index = 0; index < 10_000; index++) big.members.push(member(index));
  assert.equal(await firestorePersistSpace(OWNER, base, big), true);

  const cold = await coldRead();
  assert.equal(cold.state.members.length, 10_000);
  assert.equal(__counters.queries, 0);
  const chunks = (__store.get('gym_state_snapshots') ?? new Map()).get(`${OWNER}_0`)?.chunks ?? 1;
  assert.equal(__counters.reads, 1 + chunks);
  assert.ok(__counters.reads <= 10, `10k-doc club cold read cost ${__counters.reads} reads`);
}, { timeout: 120_000 });

test('a tripped guard blocks later cold instances cheaply across processes', async () => {
  const base = await firestoreReadSpace(OWNER);
  const next = structuredClone(base.state);
  for (let index = 0; index < 150; index++) next.members.push(member(index));
  assert.equal(await firestorePersistSpace(OWNER, base, next), true);
  __store.get('gym_state_snapshots').clear();
  const previous = process.env.GYMEG_MAX_SCAN_DOCS;
  process.env.GYMEG_MAX_SCAN_DOCS = '100';
  try {
    __clearSpaceCacheForTests();
    await assert.rejects(() => firestoreReadSpace(OWNER), /scanBudget/);
    // Second cold instance (cache cleared): marker blocks it before any scan.
    __clearSpaceCacheForTests();
    const before = __counters.docsReturned;
    await assert.rejects(() => firestoreReadSpace(OWNER), /scanBudget/);
    assert.equal(__counters.docsReturned - before, 0, 'blocked instance must not rescan');
    // An operator who deliberately raises the budget is not blocked.
    process.env.GYMEG_MAX_SCAN_DOCS = '500';
    __clearSpaceCacheForTests();
    const fine = await firestoreReadSpace(OWNER);
    assert.equal(fine.state.members.length, 150);
  } finally {
    if (previous === undefined) delete process.env.GYMEG_MAX_SCAN_DOCS; else process.env.GYMEG_MAX_SCAN_DOCS = previous;
  }
});

test('a persist racing the entity scan never serves or caches a mixed-revision state', async () => {
  const base = await firestoreReadSpace(OWNER);
  const next = structuredClone(base.state);
  next.members.push(member(1), member(2));
  assert.equal(await firestorePersistSpace(OWNER, base, next), true);
  __store.get('gym_state_snapshots').clear(); // force the scan path
  __clearSpaceCacheForTests();
  // Simulate a concurrent persist landing mid-scan: bump the revision behind
  // the scan's back when the entity query runs (first attempt only).
  __hooks.beforeQueryGet = (name) => {
    if (name !== 'gym_entities') return;
    __hooks.beforeQueryGet = undefined;
    const stateDoc = __store.get('gym_states').get(OWNER);
    __store.get('gym_states').set(OWNER, { ...stateDoc, revision: 99 });
  };
  try {
    // The retry sees revision 99 with no matching snapshot and no racing
    // writer this time: it scans and serves revision 99 coherently.
    const result = await firestoreReadSpace(OWNER);
    assert.equal(result.revision, 99);
    assert.equal(result.state.members.length, 2);
  } finally {
    __hooks.beforeQueryGet = undefined;
  }
});

test('persist write amplification stays bounded', async () => {
  const base = await firestoreReadSpace(OWNER);
  zeroCounters();
  const next = structuredClone(base.state);
  next.settings.name = 'bounded writes';
  await firestorePersistSpace(OWNER, base, next);
  // state doc + snapshot chunk + outbox + delta doc; entity diffs are empty here.
  assert.ok(__counters.writes <= 8, `persist used ${__counters.writes} writes`);
});
