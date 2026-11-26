import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { applyOperation, emptyState } from '../app/lib/domain.ts';
import { parseDevicePreferences } from '../app/lib/device-preferences.ts';
import { decryptGatewaySecret, encryptGatewaySecret, signPaymentIntent, verifyPaymentIntent, verifyWebhookSignature } from '../app/lib/payment-gateway.ts';
import { packet } from '../app/lib/workspace-packet.ts';
import { memberView } from '../app/lib/member-view.ts';
import { permitted } from '../app/lib/access.ts';

test('InBody measurements validate bodyFat, muscleMass, bmi, waterPct and visceralFat', () => {
  let s = emptyState();
  s.branches = [{ id: 'main', name: 'Main' }];
  const now = '2026-11-26T08:00:00.000Z';
  s = applyOperation(s, { type: 'member.save', branch: 'main', name: 'Ahmed Ali Hassan', phone: '01012345678', joined: '2026-11-01', expires: '2026-12-01', consent: true }, now, 'Owner', () => 'm1');
  s = applyOperation(s, {
    type: 'member.measurement',
    branch: 'main',
    id: 'm1',
    day: '2026-11-25',
    weight: 82.5,
    waist: 86,
    bodyFat: 18.4,
    muscleMass: 37.2,
    bmi: 24.6,
    waterPct: 58.1,
    visceralFat: 7,
    note: 'InBody 770',
    consent: true,
  }, now, 'Owner', () => 'id1');

  const m = s.members[0];
  assert.equal(m.measurements?.length, 1);
  assert.equal(m.measurements?.[0].bodyFat, 18.4);
  assert.equal(m.measurements?.[0].muscleMass, 37.2);
  assert.equal(m.measurements?.[0].visceralFat, 7);

  assert.throws(() => {
    applyOperation(s, {
      type: 'member.measurement',
      branch: 'main',
      id: 'm1',
      day: '2026-11-26',
      weight: 82,
      waist: null,
      bodyFat: 99,
      consent: true,
    }, now, 'Owner', () => 'id2');
  });
});

test('Turnstile gate preferences clamp pulse duration and Windows GateRelay restricts to private LAN', () => {
  const prefs = parseDevicePreferences(JSON.stringify({
    gateEnabled: true,
    gateProtocol: 'zkteco-pull',
    gateEndpoint: '192.168.1.201:4370',
    gatePulseMs: 50000,
  }));
  assert.equal(prefs.gateEnabled, true);
  assert.equal(prefs.gateProtocol, 'zkteco-pull');
  assert.equal(prefs.gateEndpoint, '192.168.1.201:4370');
  assert.equal(prefs.gatePulseMs, 10000);

  const cs = readFileSync(join(process.cwd(), 'windows', 'GateRelay.cs'), 'utf8');
  assert.match(cs, /IsPrivateLanHost/);
  assert.match(cs, /192.*168/);
});

test('Online payment gateway: owner-only config, HMAC intent signing, and memberView exposure', () => {
  assert.equal(permitted('owner', 'payment.gateway.save'), true);
  assert.equal(permitted('manager', 'payment.gateway.save'), false);
  assert.equal(permitted('reception', 'payment.gateway.save'), false);

  let s = emptyState();
  s.branches = [{ id: 'main', name: 'Main' }];
  const now = '2026-11-26T08:00:00.000Z';
  s = applyOperation(s, { type: 'member.save', branch: 'main', name: 'Sara Mohamed Adel', phone: '01099998888', joined: '2026-11-01', expires: '2026-12-01', consent: true }, now, 'Owner', () => 'm1');
  s = applyOperation(s, { type: 'plan.save', branch: 'main', name: 'Monthly VIP', days: 30, visits: null, minor: 85000 }, now, 'Owner', () => 'p1');
  s = applyOperation(s, { type: 'payment.gateway.save', branch: 'main', enabled: true, provider: 'instapay', instapayAddress: 'morgan@instapay' }, now, 'Owner', () => 'g1');

  const view = memberView(s, 'm1', 'main', now, 0, 0);
  assert.equal(view.onlinePayment.enabled, true);
  assert.equal(view.onlinePayment.provider, 'instapay');
  assert.equal(view.onlinePayment.instapayAddress, 'morgan@instapay');
  assert.equal(view.onlinePayment.plans.length, 1);

  process.env.PAYMENT_INTENT_SECRET = 'test-secret-key-for-unit-test';
  const encSecret = encryptGatewaySecret('egy_sk_test_club_secret');
  assert.notEqual(encSecret, 'egy_sk_test_club_secret');
  assert.equal(decryptGatewaySecret(encSecret), 'egy_sk_test_club_secret');

  s = applyOperation(s, {
    type: 'payment.gateway.save',
    branch: 'main',
    enabled: true,
    provider: 'paymob',
    paymobPublicKey: 'egy_pk_test_123',
    paymobIntegrationId: '4447409',
    paymobSecretKeyEnc: encSecret,
  }, now, 'Owner', () => 'g2');
  const pkt = packet({ state: s, revision: 1 }, { tenantId: 't1', owner: 'o1', role: 'owner', branches: null, user: { userId: 'u1', displayName: 'Owner' }, license: null });
  assert.equal(pkt.state.settings.paymentGateway?.paymobSecretKeyEnc, undefined);
  assert.equal(pkt.state.settings.paymentGateway?.hasPaymobSecret, true);

  const token = signPaymentIntent({
    kind: 'member_subscription',
    owner: 'owner-1',
    memberId: 'm1',
    branch: 'main',
    planId: 'p1',
    amountMinor: 85000,
    currency: 'EGP',
    provider: 'paymob',
    reference: 'GYM-TEST123',
    exp: Date.now() + 60000,
  });
  const verified = verifyPaymentIntent(token);
  assert.equal(verified?.reference, 'GYM-TEST123');
  assert.equal(verified?.kind, 'member_subscription');
  assert.equal(verifyPaymentIntent(token + 'tamper'), null);
  assert.equal(verifyWebhookSignature('{"ok":1}', 'bad', 'secret'), false);
});

test('Native iOS GymEGMembers source files and Universal Links AASA are present', () => {
  for (const rel of [
    'mobile-ios/GymEGMembers/GymEGMembersApp.swift',
    'mobile-ios/GymEGMembers/MemberWebView.swift',
    'mobile-ios/GymEGMembers/Info.plist',
    'mobile-ios/GymEGMembers/GymEGMembers.entitlements',
    'public/.well-known/apple-app-site-association',
  ]) {
    assert.ok(existsSync(join(process.cwd(), rel)), `Missing ${rel}`);
  }
});
