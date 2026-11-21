import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';

const dir=new URL('../supabase/migrations/',import.meta.url);
const files=readdirSync(dir).filter(f=>f.endsWith('.sql'));
const bodies=Object.fromEntries(files.map(f=>[f,readFileSync(new URL(f,dir),'utf8')]));

test('No migration writes cron.job directly; scheduling goes through the cron function API',()=>{
 for(const [file,sql] of Object.entries(bodies)){
  assert.ok(!/UPDATE\s+cron\.job/i.test(sql),`${file} updates cron.job directly (denied on Supabase)`);
  assert.ok(!/INSERT\s+INTO\s+cron\.job/i.test(sql),`${file} inserts into cron.job directly (denied on Supabase)`);
 }
 // Reading cron.job for idempotence is only allowed inside the privilege-tolerant
 // helper, which lives in the messaging scheduler migration.
 for(const [file,sql] of Object.entries(bodies)){
  if(file.startsWith('20261022213838_'))continue;
  assert.ok(!/FROM\s+cron\.job/i.test(sql),`${file} reads cron.job directly; use gymos.cron_install_disabled`);
 }
});

test('Every scheduled job installs disabled through gymos.cron_install_disabled',()=>{
 const helper=bodies[Object.keys(bodies).find(f=>f.startsWith('20261022213838_'))];
 assert.ok(helper.includes('CREATE OR REPLACE FUNCTION gymos.cron_install_disabled'),'helper missing');
 assert.ok(helper.includes('cron.schedule(')&&helper.includes('cron.alter_job(v_job,active=>false)'),'helper must install jobs then deactivate them');
 const jobs={'gymos-whatsapp-worker':'20261022213838_','gymos-attendance-auto-exit':'20261026224250_','gymos-backup-transfer-cleanup':'20261117134000_'};
 for(const [name,prefix] of Object.entries(jobs)){
  const file=Object.keys(bodies).find(f=>f.startsWith(prefix));
  assert.ok(file,`migration for ${name} not found`);
  assert.ok(bodies[file].includes(`cron_install_disabled('${name}'`),`${name} must install via gymos.cron_install_disabled`);
 }
});
