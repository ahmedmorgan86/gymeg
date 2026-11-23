import {test} from 'node:test';import assert from 'node:assert/strict';
import {bootstrapDb,readFile,stripUnavailableExtensions} from './db-bootstrap-helpers.mjs';

const replayFiles=[
 'supabase/migrations/20261019183227_commercial_multiclub.sql',
 'supabase/migrations/20261019185320_commercial_partition_rls.sql',
 'supabase/migrations/20261022213838_messaging_vault_scheduler.sql',
 'supabase/migrations/20261026224250_unified_member_console.sql',
 'supabase/migrations/20261117130000_db_defense_in_depth.sql',
 'supabase/migrations/20261117134000_backup_transfer_expiry_cleanup.sql',
];
test('Complete ordered bootstrap applies from an empty database and hardened migrations replay safely',async()=>{
  const db=await bootstrapDb();
  try{
    for(const file of replayFiles)await db.exec(stripUnavailableExtensions(readFile(file)));

    const requiredTables=['gym_states','gym_access','gym_invites','gym_recovery','gym_entities','gym_activity_archive','membership_cards','member_portal_access','member_code_access','tenants','tenant_licenses','tenant_memberships','activation_requests','gym_backup_transfers','whatsapp_outbox'];
    for(const table of requiredTables){
      const found=(await db.query('SELECT to_regclass($1) AS oid',[`gymos.${table}`])).rows[0].oid;
      assert.ok(found,`missing table gymos.${table}`);
    }
    const policies=(await db.query("SELECT tablename,policyname FROM pg_policies WHERE schemaname='gymos'")).rows;
    assert.equal(policies.filter(p=>p.policyname==='server_access').length,0,'legacy unscoped policy remains');
    assert.ok(policies.some(p=>p.tablename==='gym_states'&&p.policyname==='partition_runtime'));
    assert.ok(policies.some(p=>p.tablename==='member_portal_access'&&p.policyname==='member_portal_member_link'));
    const jobs=(await db.query('SELECT jobname,active FROM cron.job ORDER BY jobname')).rows;
    for(const job of jobs)assert.equal(job.active,false,`cron job ${job.jobname} must install disabled`);
    assert.ok(jobs.some(j=>j.jobname==='gymos-whatsapp-worker'));
    assert.ok(jobs.some(j=>j.jobname==='gymos-attendance-auto-exit'));
    assert.ok(jobs.some(j=>j.jobname==='gymos-backup-transfer-cleanup'));
    // The support shell's handoff client tag must survive the full ordered
    // migration chain (the CHECK-widening migration sorts after the table
    // creation, so an empty-database bootstrap cannot hit a missing table).
    const check=(await db.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='auth_handoff_codes_client_check'")).rows[0].def;
    for(const client of ['android-members','android-management','android-support'])assert.ok(check.includes(`'${client}'`),`client CHECK lost ${client}`);
    const malformed=(await db.query("SELECT gymos.safe_branches_json('not json') AS value")).rows[0].value;
    const missing=(await db.query('SELECT gymos.safe_branches_json(NULL) AS value')).rows[0].value;
    assert.deepEqual(malformed,[],'a later migration must not restore unrestricted scope for malformed grants');
    assert.deepEqual(missing,[],'a later migration must not restore unrestricted scope for missing grants');
  }finally{await db.close();}
});

test('Existing databases upgrade through the handoff table creation and the client widening in order',async()=>{
  // A database provisioned before the support client existed stops at the
  // handoff table creation, then applies the remaining migrations in order.
  // Pre-upgrade state: every migration through the handoff table creation
  // (which already includes the member-portal claim policy), i.e. the live
  // fresh target before the support client landed.
  const db=await bootstrapDb({through:'20261121210000_auth_handoff_codes.sql'});
  try{
    const before=(await db.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='auth_handoff_codes_client_check'")).rows[0].def;
    assert.ok(before.includes("'android-management'"));
    assert.ok(!before.includes("'android-support'"),'pre-upgrade state must not have the support client');
    for(const name of ['20261121213000_auth_handoff_support_client.sql']){
      await db.exec(stripUnavailableExtensions(readFile('supabase/migrations/'+name)));
    }
    const after=(await db.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='auth_handoff_codes_client_check'")).rows[0].def;
    for(const client of ['android-members','android-management','android-support'])assert.ok(after.includes(`'${client}'`),`upgrade lost ${client}`);
  }finally{await db.close();}
});
