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

const { __counters, __reset, __store } = await import('./firestore-snapshot-mock.mjs');
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
  assert.equal(await firestorePersistSpace(OWNER, base, big), true);

  const chunks = __store.get('gym_state_snapshots') ?? new Map();
  const chunkCount = chunks.get(`${OWNER}_0`)?.chunks;
  assert.ok(chunkCount > 1, `expected a multi-chunk snapshot, got ${chunkCount}`);
  assert.equal(chunks.size, chunkCount);

  const cold = await coldRead();
  assert.equal(cold.revision, 1);
  assert.equal(cold.state.members.length, 60);
  for (const [id, photo] of photos) {
    assert.equal(cold.state.members.find(m => m.id === id)?.photo, photo);
  }
  // 1 state doc + 1 read per chunk, still no entity scan.
  assert.equal(__counters.queries, 0);
  assert.equal(__counters.reads, 1 + chunkCount);

  // GC: shrinking back below the chunk count deletes the extra chunks.
  const shrunk = structuredClone(cold.state);
  for (const m of shrunk.members) delete m.photo;
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

test('persist write amplification stays bounded', async () => {
  const base = await firestoreReadSpace(OWNER);
  zeroCounters();
  const next = structuredClone(base.state);
  next.settings.name = 'bounded writes';
  await firestorePersistSpace(OWNER, base, next);
  // state doc + snapshot chunk + outbox + delta doc; entity diffs are empty here.
  assert.ok(__counters.writes <= 8, `persist used ${__counters.writes} writes`);
});
