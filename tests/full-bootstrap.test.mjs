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
  }finally{await db.close();}
});
