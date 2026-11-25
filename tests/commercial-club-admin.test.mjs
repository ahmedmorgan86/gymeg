import './acceptance-route-loader.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';

const {commercialWork} = await import('../app/lib/commercial.ts');

test('Postgres commercialWork: platform owner can update and safely delete a club with member_code_access & licenses', async () => {
 const client = await bootstrapDb();
 try {
  const ownerUser = {userId:'platform-owner-1', displayName:'Platform Owner', email:'owner@gymeg.test'};
  const otherUser = {userId:'other-user-1', displayName:'Other User', email:'other@gymeg.test'};

  await client.query('INSERT INTO gymos.platform_admins(user_id) VALUES($1) ON CONFLICT DO NOTHING', [ownerUser.userId]);
  await client.query("INSERT INTO gymos.commercial_plans(id,name,currency,limits,published) VALUES('custom','Custom','EGP','{\"branches\":5,\"members\":1000,\"staff\":20}'::jsonb,true) ON CONFLICT DO NOTHING");

  await client.query('BEGIN');
  await client.query("SELECT set_config('app.actor',$1,true)", [ownerUser.userId]);
  await client.query("SELECT set_config('app.platform','1',true)");
  const created = await commercialWork(client, true, ownerUser, {action:'create', name:'Test Delete Club'});
  assert.ok(created.id);

  const storageKey = 'tenant:' + created.id;
  await client.query("SELECT set_config('app.gym_owner',$1,true)", [storageKey]);
  await client.query(
   "INSERT INTO gymos.member_code_access(owner_id,member_id,branch,code_hash,code_cipher) VALUES($1,$2,$3,$4,$5)",
   [storageKey, 'm1', 'main', 'a'.repeat(64), 'cipher']
  );
  await client.query('COMMIT');

  // Non-platform user is forbidden from club.update and club.delete
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.actor',$1,true)", [otherUser.userId]);
  await assert.rejects(() => commercialWork(client, false, otherUser, {action:'club.update', tenant:created.id, name:'Hacked', revision:1}), /forbidden/);
  await assert.rejects(() => commercialWork(client, false, otherUser, {action:'club.delete', tenant:created.id, confirm:'DELETE_CLUB'}), /forbidden/);
  await client.query('ROLLBACK');

  // Platform owner can update club name, mode, ends_at, limits; stale revision fails with conflict
  await client.query('BEGIN');
  await client.query("SELECT set_config('app.actor',$1,true)", [ownerUser.userId]);
  await client.query("SELECT set_config('app.platform','1',true)");
  const lic = (await client.query('SELECT revision FROM gymos.tenant_licenses WHERE tenant_id=$1', [created.id])).rows[0];
  await assert.rejects(() => commercialWork(client, true, ownerUser, {action:'club.update', tenant:created.id, name:'Stale', revision:lic.revision + 99}), /conflict/);

  const updated = await commercialWork(client, true, ownerUser, {
   action:'club.update',
   tenant:created.id,
   name:'Updated Gym Name',
   mode:'annual',
   status:'active',
   ends_at:'2027-12-31',
   limits:{branches:10, members:2500, staff:50},
   revision:lic.revision
  });
  assert.equal(updated.ok, true);
  const tRow = (await client.query('SELECT name FROM gymos.tenants WHERE id=$1', [created.id])).rows[0];
  const lRow = (await client.query('SELECT mode,status,limits,revision FROM gymos.tenant_licenses WHERE tenant_id=$1', [created.id])).rows[0];
  assert.equal(tRow.name, 'Updated Gym Name');
  assert.equal(lRow.mode, 'annual');
  assert.equal(lRow.status, 'active');
  assert.equal(lRow.limits.branches, 10);
  assert.equal(lRow.revision, lic.revision + 1);

  // Platform owner can delete the club cleanly (including member_code_access, gym_states, licenses, memberships)
  const deleted = await commercialWork(client, true, ownerUser, {action:'club.delete', tenant:created.id, confirm:'DELETE_CLUB', note:'Cleanup test'});
  assert.equal(deleted.ok, true);
  await client.query('COMMIT');

  const remainingTenants = await client.query('SELECT id FROM gymos.tenants WHERE id=$1', [created.id]);
  assert.equal(remainingTenants.rowCount, 0);
  const auditRow = (await client.query("SELECT action,details FROM gymos.commercial_audit WHERE action='club.deleted' ORDER BY at DESC LIMIT 1")).rows[0];
  assert.equal(auditRow.action, 'club.deleted');
  assert.equal(auditRow.details.tenant_id, created.id);
 } finally {
  await client.close?.();
 }
});

test('All 3 Android apps wire Firebase FCM click_action and target URL routing consistently', async () => {
 const [mgmtManifest, memManifest, supManifest, mgmtFcm, supFcm, supMain, mgmtMain] = await Promise.all([
  readFile(new URL('../mobile-android/management/AndroidManifest.xml', import.meta.url), 'utf8'),
  readFile(new URL('../mobile-android/members/AndroidManifest.xml', import.meta.url), 'utf8'),
  readFile(new URL('../android-support/AndroidManifest.xml', import.meta.url), 'utf8'),
  readFile(new URL('../mobile-android/management/src/com/pushtorq/management/FcmMessageService.java', import.meta.url), 'utf8'),
  readFile(new URL('../android-support/src/com/gymos/support/FcmMessageService.java', import.meta.url), 'utf8'),
  readFile(new URL('../android-support/src/com/gymos/support/MainActivity.java', import.meta.url), 'utf8'),
  readFile(new URL('../mobile-android/management/src/com/pushtorq/management/MainActivity.java', import.meta.url), 'utf8'),
 ]);
 assert.match(mgmtManifest, /GYMEG_OPEN_NOTIFICATION/);
 assert.match(memManifest, /GYMEG_OPEN_NOTIFICATION/);
 assert.match(supManifest, /GYMEG_SUPPORT_NOTIFICATION/);
 assert.match(mgmtFcm, /\/support-requests/);
 assert.match(supFcm, /\/support-requests/);
 assert.match(supFcm, /gymeg_url/);
 assert.match(supMain, /\/support-requests/);
 assert.match(mgmtMain, /\/support-requests/);
});
