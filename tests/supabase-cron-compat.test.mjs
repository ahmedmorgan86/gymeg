import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const migrationNames = [
  '20261022213838_messaging_vault_scheduler.sql',
  '20261026224250_unified_member_console.sql',
  '20261117134000_backup_transfer_expiry_cleanup.sql',
  '20261122050000_backup_sections.sql',
];
const migrations = migrationNames.map(name =>
  readFileSync(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8'),
);
const helper = migrations[0].match(/CREATE OR REPLACE FUNCTION gymos\.cron_install_disabled[\s\S]+?REVOKE ALL ON FUNCTION gymos\.cron_install_disabled[^;]+;/)?.[0];
const blocks = migrations.map(sql => {
  const call = sql.indexOf('PERFORM gymos.cron_install_disabled(');
  return sql.slice(sql.lastIndexOf('DO $$', call), sql.indexOf('END $$;', call) + 'END $$;'.length);
});

test('migration role can install four inactive jobs without catalog permissions', async () => {
  assert.ok(helper);
  for (const sql of migrations) assert.doesNotMatch(sql, /(?:FROM|UPDATE|INTO)\s+cron\.job/i);
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE SCHEMA gymos;
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE gymos_app; CREATE ROLE migration_runner;
      GRANT USAGE ON SCHEMA gymos TO migration_runner,gymos_app;
      ${helper}
      GRANT EXECUTE ON FUNCTION gymos.cron_install_disabled(text,text,text) TO migration_runner;
    `);
    const denied = await db.query("SELECT has_function_privilege('gymos_app','gymos.cron_install_disabled(text,text,text)','EXECUTE') AS allowed");
    assert.equal(denied.rows[0].allowed, false);
    // The same migrations can replay where pg_cron is absent.
    await db.exec('BEGIN; SET LOCAL ROLE migration_runner; ' + blocks.join('\n') + ' COMMIT;');
    // Test doubles implement only the SQL interface. They never run a job.
    await db.exec(`
      CREATE SCHEMA cron;
      CREATE TABLE cron.job(id bigserial PRIMARY KEY, name text UNIQUE, expression text, command text, active boolean DEFAULT true);
      CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE sql SECURITY DEFINER AS $$
        INSERT INTO cron.job(name,expression,command) VALUES ($1,$2,$3)
        ON CONFLICT (name) DO UPDATE SET expression=excluded.expression,command=excluded.command RETURNING id;
      $$;
      CREATE FUNCTION cron.alter_job(job_id bigint, active boolean) RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
        UPDATE cron.job AS j SET active=$2 WHERE j.id=$1;
      $$;
      GRANT USAGE ON SCHEMA cron TO migration_runner;
    `);
    const privileges = await db.query("SELECT has_table_privilege('migration_runner','cron.job','SELECT') AS allowed");
    assert.equal(privileges.rows[0].allowed, false);
    const run = 'BEGIN; SET LOCAL ROLE migration_runner; ' + blocks.join('\n') + ' COMMIT;';
    await db.exec(run);
    const first = await db.query('SELECT id::text,name,active FROM cron.job ORDER BY name');
    await db.exec(run);
    const second = await db.query('SELECT id::text,name,active FROM cron.job ORDER BY name');
    assert.deepEqual(second.rows, first.rows);
    assert.deepEqual(second.rows.map(({ name, active }) => [name, active]), [
      ['gymos-attendance-auto-exit', false],
      ['gymos-backup-section-cleanup', false],
      ['gymos-backup-transfer-cleanup', false],
      ['gymos-whatsapp-worker', false],
    ]);
  } finally {
    await db.close();
  }
});
