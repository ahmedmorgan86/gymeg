import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';

// Full-chain lifecycle proof for 20261122080000: after EVERY migration, the
// sync writer can never store a reversible PIN (creation or phone change),
// the runtime role cannot decrypt or PIN-encrypt, and hash verification
// still signs members in. PGlite crypto is the local stub: this proves
// writer/grant behavior, not cryptographic strength.
test('PIN lifecycle is hash-only after the full migration chain',async()=>{
 const db=await bootstrapDb();
 try{
  await db.query('BEGIN');
  await db.query("SELECT set_config('app.gym_owner','t-owner',true)");
  await db.query("INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES('t-owner','{}',0,'synthetic')");
  await db.query('SET LOCAL ROLE gymos_app');
  const member={id:'t-member',branch:'main',name:'Test Member',phone:'01000000000',demo:false,archived:false};
  await db.query('SELECT gymos.sync_member_codes($1::jsonb)',[JSON.stringify([member])]);
  const created=(await db.query("SELECT pin_hash IS NOT NULL AS has_hash,pin_cipher IS NOT NULL AS has_cipher,pin_must_change,has_function_privilege('gymos_app','gymos.member_code_decrypt(text)','EXECUTE') AS can_decrypt,has_function_privilege('gymos_app','gymos.member_pin_encrypt(text)','EXECUTE') AS can_encrypt_pin FROM gymos.member_code_access WHERE owner_id='t-owner'")).rows[0];
  assert.equal(created.has_hash,true,'creation stores a hash');
  assert.equal(created.has_cipher,false,'creation stores no ciphertext');
  assert.equal(created.pin_must_change,true);
  assert.equal(created.can_decrypt,false,'runtime cannot decrypt');
  assert.equal(created.can_encrypt_pin,false,'runtime cannot PIN-encrypt');
  member.phone='01000000001';
  await db.query('SELECT gymos.sync_member_codes($1::jsonb)',[JSON.stringify([member])]);
  const rotated=(await db.query("SELECT pin_cipher IS NOT NULL AS has_cipher,pin_must_change FROM gymos.member_code_access WHERE owner_id='t-owner'")).rows[0];
  assert.equal(rotated.has_cipher,false,'phone change re-creates no ciphertext');
  assert.equal(rotated.pin_must_change,true);
  // Sign-in compatibility: an app-issued reset stores hash only and verifies.
  await db.query("UPDATE gymos.member_code_access SET pin_hash=gymos.member_pin_hash('482913'),pin_cipher=NULL,pin_must_change=false,version=version+1 WHERE owner_id='t-owner'");
  const signin=(await db.query("SELECT gymos.member_pin_matches('482913',pin_hash) AS ok FROM gymos.member_code_access WHERE owner_id='t-owner'")).rows[0];
  assert.equal(signin.ok,true,'correct PIN still verifies');
  // Wrong-PIN rejection needs real pgcrypto; the PGlite crypt stub is a
  // constant. That assertion stays in the real-PG gated suite
  // (tests/member-phone-db.test.mjs).
  await db.query('ROLLBACK');
 }finally{await db.close();}
});
