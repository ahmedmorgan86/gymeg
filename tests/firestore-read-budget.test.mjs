import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { gzipSync } from 'node:zlib';

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

const { __counters, __hooks, __reset, __store } = await import('./firestore-read-budget.mock.mjs');
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

for (const replaceChunk of [false, true]) {
  test(`rejects a concurrent persist between snapshot parts (replace chunk: ${replaceChunk})`, async () => {
    const owner = nextOwner();
    seed(owner);
    const states = __store.get('gym_states');
    const chunks = __store.get('gym_states/' + owner + '/revision_snapshot_v1');
    const publish = (revision, name) => {
      const bytes = gzipSync(JSON.stringify({ state: { members: [], settings: { name } }, photoIds: [] }));
      const midpoint = Math.floor(bytes.length / 2);
      [bytes.subarray(0, midpoint), bytes.subarray(midpoint)].forEach((data, index) => {
        chunks.set(String(index), { revision, count: 2, index, data });
      });
      states.set(owner, { ...states.get(owner), revision, readSnapshot: { revision, count: 2 } });
    };
    publish(1, 'Before');
    __hooks.afterDocRead = (name, id) => {
      if (name.endsWith('/revision_snapshot_v1') && id === '0') {
        __hooks.afterDocRead = null;
        if (replaceChunk) publish(2, 'After');
        else states.set(owner, { ...states.get(owner), revision: 2 });
      }
    };
    await assert.rejects(firestoreReadSpace(owner), /state changed during cold read/);
    assert.equal(__counters.queryReads, 0);
    publish(2, 'After');
    assert.equal((await firestoreReadSpace(owner)).state.settings.name, 'After');
  });
}

test('rejects a malformed later chunk at the same revision and backfills from the bounded scan', async () => {
  const owner = nextOwner();
  seed(owner);
  const states = __store.get('gym_states');
  states.set(owner, {
    payload: JSON.stringify({ _entityStorage: 1, settings: { name: 'Authoritative' } }),
    revision: 1,
    readSnapshot: { revision: 1, count: 2 },
  });
  const chunks = __store.get('gym_states/' + owner + '/revision_snapshot_v1');
  const data = gzipSync(JSON.stringify({ state: { members: [], settings: { name: 'Wrong' } }, photoIds: [] }));
  chunks.set('0', { revision: 1, count: 2, index: 0, data: data.subarray(0, 10) });
  chunks.set('1', { revision: 1, count: 3, index: 1, data: data.subarray(10) });
  const result = await firestoreReadSpace(owner);
  assert.equal(result.state.settings.name, 'Authoritative');
  assert.deepEqual(__counters.queries.map(query => query.limit), [101, 101]);
  assert.deepEqual(states.get(owner).readSnapshot, { revision: 1, count: 1 });
});

test('rehydrates an external legacy JPEG from the matching photo document', async () => {
  const owner = nextOwner();
  seed(owner);
  const states = __store.get('gym_states');
  states.set(owner, { ...states.get(owner), readSnapshot: { revision: 1, count: 1 } });
  const photo = 'data:image/jpeg;base64,/9j/';
  const member = { id: 'member-1', name: 'Member', photo: '' };
  const data = gzipSync(JSON.stringify({ state: { members: [member] }, photoIds: [member.id] }));
  __store.get('gym_states/' + owner + '/revision_snapshot_v1').set('0', { revision: 1, count: 1, index: 0, data });
  __store.get('gym_photos').set(owner + '_' + member.id, { owner_id: owner, member_id: member.id, content: photo });
  const result = await firestoreReadSpace(owner);
  assert.equal(result.state.members[0].photo, photo);
  assert.equal(__counters.queryReads, 0);
  assert.equal(__counters.docReads, 4);
});
