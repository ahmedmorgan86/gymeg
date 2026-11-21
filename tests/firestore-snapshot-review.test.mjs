// REVIEW-ONLY adversarial tests (not part of the PR). Same mock harness.
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

const OWNER = 'review-owner';
const zero = () => { __counters.reads = 0; __counters.writes = 0; __counters.queries = 0; __counters.docsReturned = 0; };
const coldRead = async () => { __clearSpaceCacheForTests(); zero(); return firestoreReadSpace(OWNER); };

const member = (i, photo) => ({
  id: randomUUID(), name: `عضو اختبار رقم ${i}`, phone: `+20100${String(1000000 + i).slice(-7)}`,
  branch: 'main', ...(photo ? { photo } : {}),
});

function buildState(base, { members, visitsPerMember = 0, photos = 0 }) {
  const s = structuredClone(base.state);
  for (let i = 0; i < members; i++) {
    const m = member(i, i < photos ? randomBytes(45_000).toString('base64') : undefined);
    s.members.push(m);
    for (let v = 0; v < visitsPerMember; v++) {
      s.visits.push({ id: randomUUID(), member: m.id, branch: 'main', at: '2026-11-01T10:00:00.000Z', leftAt: '2026-11-01T11:00:00.000Z' });
    }
  }
  return s;
}

beforeEach(async () => {
  __reset();
  const first = await firestoreReadSpace(OWNER);
  assert.equal(first.revision, 0);
});

test('REVIEW A: pre-snapshot revision scans on EVERY cold read, not once', async () => {
  const base = await firestoreReadSpace(OWNER);
  const next = buildState(base, { members: 50 });
  assert.equal(await firestorePersistSpace(OWNER, base, next), true);
  __store.get('gym_state_snapshots').clear(); // simulate pre-snapshot revision
  const r1 = await coldRead();
  const q1 = __counters.queries, d1 = __counters.docsReturned;
  const r2 = await coldRead();
  const q2 = __counters.queries, d2 = __counters.docsReturned;
  console.log(`A: cold1 queries=${q1} docs=${d1} | cold2 queries=${q2} docs=${d2} | snapshots after reads=${(__store.get('gym_state_snapshots') ?? new Map()).size}`);
  assert.equal(q2, 0, 'backfill after the first scan must make the second cold read query-free');
  assert.ok((__store.get('gym_state_snapshots') ?? new Map()).size >= 1, 'expected a backfilled snapshot');
});

test('REVIEW B: demo-scale 800 members + 12.6 docs/member - does snapshot fit and what does a scan cost', async () => {
  const base = await firestoreReadSpace(OWNER);
  // ~12.6 docs/member: 1 member + ~10 visits + ~1.6 payment/invoice-ish rows
  const next = buildState(base, { members: 800, visitsPerMember: 10 });
  for (let i = 0; i < 1300; i++) next.payments.push({ id: randomUUID(), member: next.members[i % 800].id, amount: 300, at: '2026-11-01T10:00:00.000Z', branch: 'main' });
  const jsonBytes = Buffer.byteLength(JSON.stringify(next));
  assert.equal(await firestorePersistSpace(OWNER, base, next), true);
  const snaps = __store.get('gym_state_snapshots') ?? new Map();
  const chunkMeta = snaps.get(`${OWNER}_0`);
  const entityDocs = __store.get('gym_entities').size;
  console.log(`B: state JSON=${(jsonBytes/1e6).toFixed(2)}MB entities=${entityDocs} snapshotChunks=${chunkMeta ? chunkMeta.chunks : 'NONE'}`);
  const cold = await coldRead();
  console.log(`B: cold read docs read=${__counters.reads} queryDocsReturned=${__counters.docsReturned} queries=${__counters.queries}`);
  // now without snapshot (pre-snapshot revision): a 10.1k-doc club exceeds
  // the default 2,000-doc scan guard and fails closed instead of burning
  // half the daily quota. The explicit operator bootstrap script is what
  // snapshots clubs this size, not a hidden first-visit scan.
  __store.get('gym_state_snapshots').clear();
  await assert.rejects(() => coldRead(), /scanBudget/);
  console.log(`B: cold read WITHOUT snapshot failed closed (club over default scan guard)`);
  // With a deliberate operator-sized budget the one-time scan+backfill works.
  const prev = process.env.GYMEG_MAX_SCAN_DOCS;
  process.env.GYMEG_MAX_SCAN_DOCS = '25000';
  try {
    const cold2 = await coldRead();
    console.log(`B: bootstrap scan docs=${__counters.reads} queryDocsReturned=${__counters.docsReturned}`);
    assert.equal(cold2.revision, 1);
    const cold3 = await coldRead();
    assert.equal(__counters.queries, 0, 'after bootstrap, cold reads are query-free');
  } finally {
    if (prev === undefined) delete process.env.GYMEG_MAX_SCAN_DOCS; else process.env.GYMEG_MAX_SCAN_DOCS = prev;
  }
  assert.equal(cold.revision, 1);
});

test('REVIEW C: photo-heavy club over 8 chunks gets NO snapshot and scans every cold read', async () => {
  const base = await firestoreReadSpace(OWNER);
  const next = buildState(base, { members: 300, photos: 120 }); // 120 x ~60KB base64 ~ 7.2MB raw
  const jsonBytes = Buffer.byteLength(JSON.stringify(next));
  assert.equal(await firestorePersistSpace(OWNER, base, next), true);
  const snaps = __store.get('gym_state_snapshots') ?? new Map();
  console.log(`C: state JSON=${(jsonBytes/1e6).toFixed(2)}MB snapshotDocs=${snaps.size}`);
  const cold = await coldRead();
  console.log(`C: cold read queries=${__counters.queries} docsReturned=${__counters.docsReturned} reads=${__counters.reads}`);
  // Photos now live only in gym_photos docs, so the snapshot fits and the
  // cold read is 1 state doc + chunks + one read per photo, with no scan.
  assert.ok(snaps.size >= 1, 'photo-heavy club must get a snapshot now');
  assert.equal(__counters.queries, 0, 'photo-heavy cold read must not scan');
  assert.equal(cold.state.members.filter(m => m.photo).length, 120, 'photos re-attached');
});
