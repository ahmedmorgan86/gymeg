import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const migration=readFileSync(new URL('../supabase/migrations/20261117120000_remove_shared_member_pins.sql',import.meta.url),'utf8');
const memberCodeRoute=readFileSync(new URL('../app/api/member-code/route.ts',import.meta.url),'utf8');
const memberPinRoute=readFileSync(new URL('../app/api/member-pin/route.ts',import.meta.url),'utf8');
test('PIN migration replaces the shared default, remediates existing rows and revokes old sessions',()=>{
  assert.match(migration,/CREATE OR REPLACE FUNCTION gymos\.new_member_pin/);
  assert.match(migration,/ARRAY\['000000','111111','123456','654321'\]/);
  assert.match(migration,/pin:=gymos\.new_member_pin\(\)/);
  assert.match(migration,/gymos\.member_pin_matches\(value,a\.pin_hash\)/);
  assert.match(migration,/pin_must_change=true/);
  assert.match(migration,/DELETE FROM gymos\.member_code_sessions/);
  assert.doesNotMatch(migration,/pin:='123456'/);
  assert.doesNotMatch(migration,/gymos\.member_pin_hash\('123456'\)/);
});
test('Application writes and accepts only generated non-shared PINs',()=>{
  assert.doesNotMatch(memberCodeRoute,/const pin='123456'/);
  assert.match(memberCodeRoute,/newMemberPin\(currentPin\)/);
  assert.doesNotMatch(memberPinRoute,/pin==='123456'/);
  assert.match(memberPinRoute,/isSharedLegacyPin\(pin\)/);
  assert.match(memberPinRoute,/licenseState\(normalizeLicense\(license\)\)\.writable/);
});
