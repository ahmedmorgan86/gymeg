import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceSyncManager} from '../app/lib/workspace-sync.ts';

test('catch-up advances through filtered pages and stores the covered revision', async t => {
  let packet = {revision: 5, state: {members: []}};
  const cursors = [];
  t.mock.method(globalThis, 'fetch', async input => {
    const cursor = Number(new URL(input, 'https://fixture.test').searchParams.get('after'));
    cursors.push(cursor);
    if (cursor === 5 && cursors.length === 1) {
      return Response.json({requiresSnapshot: false, fromRevision: 5, toRevision: 8, hasMore: true, events: []});
    }
    assert.equal(cursor, 8);
    return Response.json({
      requiresSnapshot: false, fromRevision: 8, toRevision: 12, hasMore: false,
      events: [{id: 'test', revision: 9, collection: 'members', entityId: 'x', eventType: 'entity.upsert', payload: {id: 'x'}}],
    });
  });
  const manager = new WorkspaceSyncManager({
    tenantId: 'fixture', owner: 'fixture', initialRevision: 5, getCurrentPacket: () => packet,
    onPacketUpdate: next => { packet = next; }, onSnapshotRequired: () => assert.fail('unexpected full refresh'),
  });
  assert.equal(await manager.pullDeltas(), true);
  assert.deepEqual(cursors, [5, 8]);
  assert.equal(packet.revision, 12);
  assert.deepEqual(packet.state.members, [{id: 'x'}]);
});

test('a non-advancing page requests a snapshot instead of polling the same revision', async t => {
  const packet = {revision: 5, state: {}};
  const fetcher = t.mock.method(globalThis, 'fetch', async () => Response.json({
    requiresSnapshot: false, fromRevision: 5, toRevision: 5, hasMore: true, events: [],
  }));
  let refreshes = 0;
  const manager = new WorkspaceSyncManager({
    tenantId: 'fixture', owner: 'fixture', initialRevision: 5, getCurrentPacket: () => packet,
    onPacketUpdate: () => assert.fail('unexpected packet update'), onSnapshotRequired: () => { refreshes++; },
  });
  assert.equal(await manager.pullDeltas(), false);
  assert.equal(fetcher.mock.callCount(), 1);
  assert.equal(refreshes, 1);
});
