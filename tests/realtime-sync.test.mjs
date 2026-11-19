import {test} from 'node:test';
import assert from 'node:assert/strict';
import {applyWorkspaceDeltas, WorkspaceSyncManager} from '../app/lib/workspace-sync.ts';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';

test('applyWorkspaceDeltas: correctly applies entity upsert, delete and metadata updates', () => {
  const initialPacket = {
    revision: 10,
    owner: 'tenant-123',
    serverNow: Date.now(),
    admin: true,
    role: 'owner',
    user: { id: 'u1', name: 'Admin' },
    state: {
      settings: { name: 'Gym Alpha', currency: 'EGP', timezone: 'Africa/Cairo' },
      branches: [{ id: 'b1', name: 'Main' }],
      members: [
        { id: 'm1', name: 'Captain Marvel', phone: '01000000001', branch: 'b1', archived: false },
        { id: 'm2', name: 'Iron Man', phone: '01000000002', branch: 'b1', archived: false }
      ],
      visits: [],
      invoices: [],
      payments: [],
      plans: [],
      classes: [],
      events: []
    }
  };

  const deltas = [
    // 1. Upsert: modify m1 name
    {
      id: 'e1',
      revision: 11,
      eventType: 'entity.upsert',
      collection: 'members',
      entityId: 'm1',
      branch: 'b1',
      payload: { id: 'm1', name: 'Captain Marvel (Updated)', phone: '01000000001', branch: 'b1', archived: false }
    },
    // 2. Upsert: add new member m3
    {
      id: 'e2',
      revision: 12,
      eventType: 'entity.upsert',
      collection: 'members',
      entityId: 'm3',
      branch: 'b1',
      payload: { id: 'm3', name: 'Thor Odinson', phone: '01000000003', branch: 'b1', archived: false }
    },
    // 3. Delete: remove m2
    {
      id: 'e3',
      revision: 13,
      eventType: 'entity.delete',
      collection: 'members',
      entityId: 'm2',
      branch: 'b1'
    },
    // 4. Metadata: update gym settings name
    {
      id: 'e4',
      revision: 14,
      eventType: 'metadata.update',
      collection: '_metadata',
      entityId: 'settings',
      payload: { settings: { name: 'Gym Alpha Prime' } }
    }
  ];

  const updated = applyWorkspaceDeltas(initialPacket, deltas);

  assert.equal(updated.revision, 14, 'Revision should advance to the highest event revision');
  assert.equal(updated.state.settings.name, 'Gym Alpha Prime', 'Settings name should be updated');
  assert.equal(updated.state.members.length, 2, 'Should have 2 members after 1 addition and 1 deletion');
  assert.equal(updated.state.members.find(m => m.id === 'm1')?.name, 'Captain Marvel (Updated)');
  assert.equal(updated.state.members.find(m => m.id === 'm3')?.name, 'Thor Odinson');
  assert.equal(updated.state.members.find(m => m.id === 'm2'), undefined, 'm2 should be deleted');
});

test('WorkspaceSyncManager: tracks local revision and handles lifecycle', async () => {
  let snapshotRequested = false;

  const syncManager = new WorkspaceSyncManager({
    tenantId: 'tenant-test',
    owner: 'owner-test',
    initialRevision: 5,
    onPacketUpdate: () => {},
    onSnapshotRequired: () => {
      snapshotRequested = true;
    }
  });

  assert.equal(syncManager.getStatus(), 'connecting');
  syncManager.updateLocalRevision(10);
  assert.equal(syncManager['currentRevision'], 10);

  syncManager.destroy();
  assert.equal(snapshotRequested, false);
});

test('PostgreSQL: workspace_events and workspace_outbox migration with tenant isolation and pruning', async () => {
  const db = await bootstrapDb();
  try {
    // 1. Verify table creation
    const eventTable = (await db.query("SELECT to_regclass('gymos.workspace_events') AS oid")).rows[0].oid;
    const outboxTable = (await db.query("SELECT to_regclass('gymos.workspace_outbox') AS oid")).rows[0].oid;
    assert.ok(eventTable, 'gymos.workspace_events table must exist');
    assert.ok(outboxTable, 'gymos.workspace_outbox table must exist');

    // 2. Insert test events for gym-a and gym-b
    await db.query(
      `INSERT INTO gymos.workspace_events(id, owner_id, tenant_id, revision, event_type, collection, entity_id, branch, payload)
       VALUES('e-a1', 'gym-a', 'tenant-a', 1, 'entity.upsert', 'members', 'm1', 'main', '{"name":"Alice"}'::jsonb),
             ('e-a2', 'gym-a', 'tenant-a', 2, 'entity.upsert', 'members', 'm2', 'main', '{"name":"Bob"}'::jsonb),
             ('e-b1', 'gym-b', 'tenant-b', 1, 'entity.upsert', 'members', 'm3', 'east', '{"name":"Charlie"}'::jsonb)`
    );

    // 3. Test RLS / tenant filtering: querying with owner scope gym-a as runtime role gymos_app
    await db.exec("SET ROLE gymos_app;SELECT set_config('app.gym_owner', 'gym-a', false)");
    const gymAEvents = (await db.query("SELECT id, revision, tenant_id FROM gymos.workspace_events ORDER BY revision ASC")).rows;
    assert.equal(gymAEvents.length, 2);
    assert.equal(gymAEvents[0].id, 'e-a1');
    assert.equal(gymAEvents[1].id, 'e-a2');

    // 4. Test RLS: gym-a role cannot read gym-b events even when querying for gym-b
    const crossTenantEvents = (await db.query("SELECT id FROM gymos.workspace_events WHERE owner_id = 'gym-b'")).rows;
    assert.equal(crossTenantEvents.length, 0, 'Cross-tenant events must not leak under gym-a scope');
    await db.exec('RESET ROLE');

    // 5. Test Outbox
    await db.query(
      `INSERT INTO gymos.workspace_outbox(id, owner_id, tenant_id, channel, event, payload)
       VALUES('out-1', 'gym-a', 'tenant-a', 'club:tenant-a:workspace', 'workspace.updated', '{"revision":2}'::jsonb)`
    );
    const outboxRows = (await db.query("SELECT id, channel FROM gymos.workspace_outbox WHERE owner_id = 'gym-a' AND processed_at IS NULL")).rows;
    assert.equal(outboxRows.length, 1);
    assert.equal(outboxRows[0].channel, 'club:tenant-a:workspace');

    // 6. Test Pruning Function
    // Insert revisions 3, 4, 5 for gym-a
    await db.query(
      `INSERT INTO gymos.workspace_events(id, owner_id, tenant_id, revision, event_type, collection, entity_id)
       VALUES('e-a3', 'gym-a', 'tenant-a', 3, 'entity.delete', 'members', 'm1'),
             ('e-a4', 'gym-a', 'tenant-a', 4, 'entity.delete', 'members', 'm2'),
             ('e-a5', 'gym-a', 'tenant-a', 5, 'entity.upsert', 'members', 'm4')`
    );

    // Keep only the latest 2 revisions (revisions 4 and 5)
    const pruned = (await db.query("SELECT gymos.prune_workspace_events('gym-a', 2) AS n")).rows[0].n;
    assert.equal(pruned, 3, 'Revisions 1, 2, and 3 should be pruned');

    const remaining = (await db.query("SELECT revision FROM gymos.workspace_events WHERE owner_id = 'gym-a' ORDER BY revision ASC")).rows;
    assert.deepEqual(remaining.map(r => r.revision), [4, 5]);

  } finally {
    await db.close();
  }
});
