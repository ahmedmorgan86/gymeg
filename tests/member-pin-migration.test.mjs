import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const migration=readFileSync(new URL('../supabase/migrations/20261117120000_remove_shared_member_pins.sql',import.meta.url),'utf8');
const memberCodeRoute=readFileSync(new URL('../app/api/member-code/route.ts',import.meta.url),'utf8');
const memberPinRoute=readFileSync(new URL('../app/api/member-pin/route.ts',import.meta.url),'utf8');
test('PIN migration replaces the shared default, remediates existing rows and revokes old sessions',()=>{
  assert.match(migration,/CREATE OR REPLACE FUNCTION gymos\.new_member_pin/);
  assert.match(migration,/ARRAY\['000000','111111','123456','654321'\]/);
  assert.match(migration,/pin:=gymos\.new_member_pin\(\)/);
  assert.match(migration,/gymos\.member_pin_matches\(value,a\.pin_hash\)/);
  assert.doesNotMatch(migration,/member_code_decrypt/);
  assert.match(migration,/pin_must_change=true/);
  assert.match(migration,/DELETE FROM gymos\.member_code_sessions/);
  assert.doesNotMatch(migration,/pin:='123456'/);
  assert.doesNotMatch(migration,/gymos\.member_pin_hash\('123456'\)/);
});
test('Application writes and accepts only generated non-shared PINs',()=>{
  assert.doesNotMatch(memberCodeRoute,/const pin='123456'/);
  assert.match(memberCodeRoute,/newMemberPin\(\)/);
  // PINs are hash-only: the staff-facing route never encrypts a new PIN for
  // later display and never decrypts a stored one.
  assert.doesNotMatch(memberCodeRoute,/member_pin_encrypt/);
  assert.doesNotMatch(memberCodeRoute,/member_code_decrypt\(pin_cipher\)/);
  assert.doesNotMatch(memberPinRoute,/pin==='123456'/);
  assert.match(memberPinRoute,/isSharedLegacyPin\(pin\)/);
  assert.match(memberPinRoute,/licenseState\(normalizeLicense\(license\)\)\.writable/);
});

test('Member phone sign-in uses the SECURITY DEFINER projection, never a direct table read',()=>{
  const sessionRoute=readFileSync(new URL('../app/api/member-session/route.ts',import.meta.url),'utf8');
  assert.match(sessionRoute,/FROM gymos\.member_phone_login\(\$1,\$2\)/);
  assert.doesNotMatch(sessionRoute,/FROM gymos\.member_code_access\b/);
  assert.doesNotMatch(sessionRoute,/app\.member_phone/);
  const defense=readFileSync(new URL('../supabase/migrations/20261117130000_db_defense_in_depth.sql',import.meta.url),'utf8');
  assert.match(defense,/DROP POLICY IF EXISTS member_phone_login/);
  assert.match(defense,/CREATE OR REPLACE FUNCTION gymos\.member_phone_login/);
});
