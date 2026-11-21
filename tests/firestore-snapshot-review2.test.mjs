// REVIEW ROUND 2 (local only, not for merge). Targets c013c00 claims.
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

const OWNER = 'r2-owner';
const zero = () => { __counters.reads = 0; __counters.writes = 0; __counters.queries = 0; __counters.docsReturned = 0; };
const coldRead = () => { __clearSpaceCacheForTests(); zero(); return firestoreReadSpace(OWNER); };
const member = (i, photo) => ({ id: randomUUID(), name: `عضو ${i}`, phone: `+20100${String(1000000+i).slice(-7)}`, branch: 'main', ...(photo ? { photo } : {}) });
const withCap = async (cap, fn) => {
  const prev = process.env.GYMEG_MAX_SCAN_DOCS;
  process.env.GYMEG_MAX_SCAN_DOCS = String(cap);
  try { return await fn(); } finally { prev === undefined ? delete process.env.GYMEG_MAX_SCAN_DOCS : process.env.GYMEG_MAX_SCAN_DOCS = prev; }
};

beforeEach(async () => {
  __reset();
  const first = await firestoreReadSpace(OWNER);
  assert.equal(first.revision, 0);
});

test('T1: guard pre-bounds the entity fetch (cap+1 max returned)', async () => {
  const base = await firestoreReadSpace(OWNER);
  const next = structuredClone(base.state);
  for (let i = 0; i < 150; i++) next.members.push(member(i));
  await firestorePersistSpace(OWNER, base, next);
  __store.get('gym_state_snapshots').clear();
  await withCap(100, async () => {
    await assert.rejects(() => coldRead(), /scanBudget/);
    console.log(`T1: docsReturned=${__counters.docsReturned} reads=${__counters.reads} (cap 100)`);
    assert.ok(__counters.docsReturned <= 101, `fetched ${__counters.docsReturned} docs despite cap 100`);
  });
});

test('T2: aggregate budget spans entity + photo queries', async () => {
  const base = await firestoreReadSpace(OWNER);
  const next = structuredClone(base.state);
  for (let i = 0; i < 120; i++) next.members.push(member(i, randomBytes(100).toString('base64')));
  await firestorePersistSpace(OWNER, base, next); // 120 entities + 120 photos = 240 docs
  __store.get('gym_state_snapshots').clear();
  await withCap(150, async () => {
    await assert.rejects(() => coldRead(), /scanBudget/);
    console.log(`T2: docsReturned=${__counters.docsReturned} (cap 150, club 240)`);
    assert.ok(__counters.docsReturned <= 151, `fetched ${__counters.docsReturned}`);
  });
});

test('T3: a tripped guard makes repeated fail-closed attempts cheap (durable marker)', async () => {
  const base = await firestoreReadSpace(OWNER);
  const next = structuredClone(base.state);
  for (let i = 0; i < 150; i++) next.members.push(member(i));
  await firestorePersistSpace(OWNER, base, next);
  __store.get('gym_state_snapshots').clear();
  await withCap(100, async () => {
    await assert.rejects(() => coldRead(), /scanBudget/);
    const b1 = __counters.reads + __counters.docsReturned;
    await assert.rejects(() => coldRead(), /scanBudget/);
    const b2 = __counters.reads + __counters.docsReturned;
    console.log(`T3: attempt1 billed=${b1}, attempt2 billed=${b2} - durable marker blocks the retry`);
    assert.ok(b1 > 100, 'first attempt paid the bounded scan before tripping');
    assert.ok(b2 <= 5, `second cold instance billed ${b2} (marker must block rescan)`);
  });
});

test('T4: photo removal and change are served correctly via snapshot path', async () => {
  const base = await firestoreReadSpace(OWNER);
  const m = member(1, randomBytes(1000).toString('base64'));
  const s1 = structuredClone(base.state); s1.members.push(m);
  await firestorePersistSpace(OWNER, base, s1);
  const cold1 = await coldRead();
  assert.ok(cold1.state.members[0].photo, 'photo present at rev 1');
  // change the photo
  const s2 = structuredClone(cold1.state); s2.members[0].photo = randomBytes(1000).toString('base64');
  await firestorePersistSpace(OWNER, cold1, s2);
  const cold2 = await coldRead();
  assert.equal(cold2.state.members[0].photo, s2.members[0].photo, 'changed photo served');
  // remove the photo
  const s3 = structuredClone(cold2.state); delete s3.members[0].photo;
  await firestorePersistSpace(OWNER, cold2, s3);
  const cold3 = await coldRead();
  assert.equal(cold3.state.members[0].photo, undefined, 'removed photo stays removed');
});

test('T5: manually planted stale-revision chunks are never served; scan repairs', async () => {
  const base = await firestoreReadSpace(OWNER);
  const s1 = structuredClone(base.state); s1.settings.name = 'revision-one';
  await firestorePersistSpace(OWNER, base, s1);
  const staleChunks = new Map(__store.get('gym_state_snapshots')); // rev-1 chunks
  const s2base = await firestoreReadSpace(OWNER);
  const s2 = structuredClone(s2base.state); s2.settings.name = 'revision-two';
  await firestorePersistSpace(OWNER, s2base, s2);
  // worst case: a stale writer overwrites the chunk docs with rev-1 content
  for (const [k, v] of staleChunks) __store.get('gym_state_snapshots').set(k, v);
  const cold = await coldRead();
  assert.equal(cold.revision, 2);
  assert.equal(cold.state.settings.name, 'revision-two', 'stale chunks must not be served');
  const cold2 = await coldRead();
  assert.equal(__counters.queries, 0, 'repair backfill makes next cold read query-free');
});

test('T6: oversized stripped state - snapshot skipped, scan recurs every cold read (bounded)', async () => {
  const base = await firestoreReadSpace(OWNER);
  const s1 = structuredClone(base.state);
  s1.settings.notes = randomBytes(6_000_000).toString('base64'); // ~8MB incompressible -> >8 chunks
  s1.members.push(member(1), member(2));
  await firestorePersistSpace(OWNER, base, s1);
  assert.equal((__store.get('gym_state_snapshots') ?? new Map()).size, 0, 'oversized: no snapshot');
  const c1 = await coldRead();
  const q1 = __counters.queries;
  const c2 = await coldRead();
  const q2 = __counters.queries;
  console.log(`T6: cold1 queries=${q1} reads-recurring; cold2 queries=${q2} (backfill cannot help oversized states)`);
  assert.ok(q1 >= 1 && q2 >= 1, 'oversized stripped state rescans every cold read');
}, { timeout: 120_000 });

test('T8: a missing photo doc silently drops the member photo', async () => {
  const base = await firestoreReadSpace(OWNER);
  const m = member(1, randomBytes(1000).toString('base64'));
  const s1 = structuredClone(base.state); s1.members.push(m);
  await firestorePersistSpace(OWNER, base, s1);
  __store.get('gym_photos').clear(); // photo doc lost (manual delete, TTL, etc.)
  const cold = await coldRead();
  assert.equal(cold.state.members[0].photo, undefined, 'missing photo doc = member served without photo, no error');
  console.log('T8: missing photo doc -> silent photo drop, read succeeds');
});
