import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { protectPin, pinMatches, revealPin, phoneDigest } from '../app/lib/firebase-member-auth.ts';

const original = process.env.GYMEG_MEMBER_PIN_KEY;
process.env.GYMEG_MEMBER_PIN_KEY = randomBytes(32).toString('base64');
test('Firebase member PINs require the right secret and PIN; stored values do not reveal the PIN', () => {
  const record = protectPin('748392');
  assert.equal(pinMatches('748392', record), true);
  assert.equal(pinMatches('748391', record), false);
  assert.equal(revealPin(record.pin_cipher), '748392');
  assert.doesNotMatch(JSON.stringify(record), /748392/);
  assert.equal(phoneDigest('+201000000000'), phoneDigest('+201000000000'));
  const previous = process.env.GYMEG_MEMBER_PIN_KEY;
  process.env.GYMEG_MEMBER_PIN_KEY = randomBytes(32).toString('base64');
  try { assert.equal(pinMatches('748392', record), false); assert.throws(() => revealPin(record.pin_cipher)); }
  finally { process.env.GYMEG_MEMBER_PIN_KEY = previous; }
});
test('Missing credential key fails closed', () => {
  const previous = process.env.GYMEG_MEMBER_PIN_KEY;
  delete process.env.GYMEG_MEMBER_PIN_KEY;
  try { assert.throws(() => protectPin('748392'), /not configured/); }
  finally { process.env.GYMEG_MEMBER_PIN_KEY = previous; }
});
process.on('exit', () => { if (original === undefined) delete process.env.GYMEG_MEMBER_PIN_KEY; else process.env.GYMEG_MEMBER_PIN_KEY = original; });
