import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'firebase-admin/app' || specifier === 'firebase-admin/firestore') {
      return { url: new URL('./firestore-read-budget.mock.mjs', import.meta.url).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

process.env.GYMEG_FIREBASE_PROJECT_ID = 'scan-budget-test';
process.env.GYMEG_MAX_SCAN_DOCS = '100';

const { __counters, __reset, __store } = await import('./firestore-read-budget.mock.mjs');
const { FirestoreReadBudgetError, firestoreReadSpace } = await import('../app/lib/firestore-db.ts');
const OWNER_PREFIX = 'scan-budget-owner';
let ownerCounter = 0;

function nextOwner() {
  ownerCounter += 1;
  return `${OWNER_PREFIX}-${ownerCounter}`;
}

function seed(owner, { entities = 0, photos = 0 } = {}) {
  __store.get('gym_states').set(owner, {
    payload: JSON.stringify({ _entityStorage: 1 }),
    revision: 1,
  });
  const entityStore = __store.get('gym_entities');
  for (let index = 0; index < entities; index++) {
    entityStore.set(`${owner}_member_${index}`, { owner_id: owner, collection: 'members', position: index });
  }
  const photoStore = __store.get('gym_photos');
  for (let index = 0; index < photos; index++) {
    photoStore.set(`${owner}_photo_${index}`, { owner_id: owner, member_id: `member-${index}`, content: 'photo' });
  }
}

beforeEach(() => {
  __reset();
  process.env.GYMEG_MAX_SCAN_DOCS = '100';
});

test('entity scan is limited to the configured budget plus one sentinel', async () => {
  const owner = nextOwner();
  seed(owner, { entities: 150, photos: 20 });
  await assert.rejects(() => firestoreReadSpace(owner), error => {
    assert.ok(error instanceof FirestoreReadBudgetError);
    assert.equal(error.scanned, 101);
    assert.equal(error.limit, 100);
    return true;
  });
  assert.equal(__counters.returnedDocs, 101);
  assert.deepEqual(__counters.queries.map(query => query.collection), ['gym_entities']);
  assert.equal(__counters.queries[0].limit, 101);
});

test('photo scan shares the same budget as the entity scan', async () => {
  const owner = nextOwner();
  seed(owner, { entities: 60, photos: 60 });
  await assert.rejects(() => firestoreReadSpace(owner), error => {
    assert.ok(error instanceof FirestoreReadBudgetError);
    assert.equal(error.scanned, 101);
    assert.equal(error.limit, 100);
    return true;
  });
  assert.equal(__counters.returnedDocs, 101);
  assert.deepEqual(__counters.queries.map(query => query.collection), ['gym_entities', 'gym_photos']);
  assert.equal(__counters.queries[0].limit, 101);
  assert.equal(__counters.queries[1].limit, 41);
});

test('invalid or oversized environment limits fail before issuing collection scans', async () => {
  const owner = nextOwner();
  seed(owner, { entities: 1 });
  process.env.GYMEG_MAX_SCAN_DOCS = '50001';
  await assert.rejects(() => firestoreReadSpace(owner), /GYMEG_MAX_SCAN_DOCS must be an integer/);
  assert.equal(__counters.queryReads, 0);
});
