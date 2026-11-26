import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrapDb } from './db-bootstrap-helpers.mjs';
import {
  deriveWppSessionId,
  evaluateAutoReply,
  isSafeWebhookUrl,
  renderWhatsAppText,
  signWorkerPayload,
  verifyWorkerRequest,
} from '../app/lib/wppconnect.ts';
import { renderParameter, templateMessage, whatsappRule } from '../app/lib/whatsapp.ts';

test('WPPConnect session IDs are non-predictable and strictly scoped by tenant + branch', () => {
  const aMain = deriveWppSessionId('club-a', 'main');
  const aBranch2 = deriveWppSessionId('club-a', 'branch-2');
  const bMain = deriveWppSessionId('club-b', 'main');

  assert.match(aMain, /^gym_[a-f0-9]{24}$/);
  assert.notEqual(aMain, aBranch2);
  assert.notEqual(aMain, bMain);
  assert.equal(aMain, deriveWppSessionId('club-a', 'main'));
});

test('Worker HMAC authentication verifies valid payloads and rejects tampering or replay', () => {
  process.env.GYMEG_WPP_WORKER_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const now = 1795700000000;
  const body = JSON.stringify({ kind: 'session', status: 'CONNECTED' });
  const ts = String(now);
  const sig = signWorkerPayload(ts, body, process.env.GYMEG_WPP_WORKER_SECRET);

  const validReq = new Request('https://gymeg.vercel.app/api/whatsapp/worker/report', {
    method: 'POST',
    headers: { 'x-gymeg-worker-timestamp': ts, 'x-gymeg-worker-signature': sig },
  });
  assert.equal(verifyWorkerRequest(validReq, body, now + 1000), true);

  // Tampered body fails
  assert.equal(verifyWorkerRequest(validReq, body + ' ', now + 1000), false);

  // Expired timestamp (>5 min) fails anti-replay
  assert.equal(verifyWorkerRequest(validReq, body, now + 6 * 60 * 1000), false);

  // Missing/wrong signature fails
  const badReq = new Request('https://gymeg.vercel.app/api/whatsapp/worker/report', {
    method: 'POST',
    headers: { 'x-gymeg-worker-timestamp': ts, 'x-gymeg-worker-signature': 'f'.repeat(64) },
  });
  assert.equal(verifyWorkerRequest(badReq, body, now + 1000), false);
});

test('SSRF guard blocks private LAN/HTTP URLs and allows public HTTPS URLs', () => {
  assert.equal(isSafeWebhookUrl('https://gymeg.vercel.app/api/whatsapp/wpp-webhook'), true);
  assert.equal(isSafeWebhookUrl('http://gymeg.vercel.app/api/whatsapp/wpp-webhook'), false);
  assert.equal(isSafeWebhookUrl('https://127.0.0.1:21465/hook'), false);
  assert.equal(isSafeWebhookUrl('https://192.168.1.50/hook'), false);
  assert.equal(isSafeWebhookUrl('https://10.0.0.5/hook'), false);
  assert.equal(isSafeWebhookUrl('https://localhost/hook'), false);
});

test('Template rendering and rule-based auto-reply handle keywords, hours, cooldown, and handoff', () => {
  const rendered = renderWhatsAppText('أهلاً {name} في {gym} ({branch})، ينتهي في {expires}، رصيد {balance}', {
    name: 'أحمد',
    gym: 'Morgan Club',
    branch: 'المعادي',
    expires: '2026-12-30',
    balance: '150 EGP',
  });
  assert.equal(rendered, 'أهلاً أحمد في Morgan Club (المعادي)، ينتهي في 2026-12-30، رصيد 150 EGP');

  const rules = [
    {
      id: 'r1',
      enabled: true,
      keywords: ['مواعيد', 'hours'],
      reply_text: 'أهلًا بك في {gym}. المواعيد من 7 صباحاً حتى 11 مساءً.',
      welcome_text: 'مرحباً بك في {gym}!',
      off_hours_text: 'نحن مغلقون الآن، سنرد عليك صباحاً.',
      active_days: [0, 1, 2, 3, 4, 5, 6],
      start_hour: 7,
      end_hour: 23,
      handoff_to_staff: true,
      cooldown_minutes: 30,
    },
  ];

  // Keyword match during working hours (Cairo 12:00 UTC+2 = 10:00Z)
  const hit = evaluateAutoReply({
    rules,
    inboundText: 'ممكن اعرف مواعيد الجيم؟',
    isFirstMessage: false,
    lastAutoReplyAt: null,
    nowIso: '2026-11-26T10:00:00.000Z',
    timeZone: 'Africa/Cairo',
    vars: { gym: 'Morgan Club' },
  });
  assert.equal(hit?.matchedRuleId, 'r1');
  assert.equal(hit?.handoff, true);
  assert.match(hit?.replyText ?? '', /Morgan Club/);

  // Cooldown prevents repeated auto-reply spam
  const blockedCooldown = evaluateAutoReply({
    rules,
    inboundText: 'مواعيد الجيم',
    isFirstMessage: false,
    lastAutoReplyAt: '2026-11-26T09:50:00.000Z',
    nowIso: '2026-11-26T10:00:00.000Z',
    timeZone: 'Africa/Cairo',
    vars: { gym: 'Morgan Club' },
  });
  assert.equal(blockedCooldown, null);

  // Off-hours reply (Cairo 03:00 = 01:00Z)
  const offHours = evaluateAutoReply({
    rules,
    inboundText: 'مواعيد',
    isFirstMessage: false,
    lastAutoReplyAt: null,
    nowIso: '2026-11-26T01:00:00.000Z',
    timeZone: 'Africa/Cairo',
    vars: { gym: 'Morgan Club' },
  });
  assert.match(offHours?.replyText ?? '', /مغلقون/);
});

test('Meta Cloud API whatsappRule and templateMessage remain 100% backwards-compatible', () => {
  const rule = whatsappRule.parse({
    id: '11111111-1111-4111-8111-111111111111',
    branch: 'main',
    name: 'Renewal',
    kind: 'renewal',
    enabled: true,
    time: '09:00',
    template: 'gym_renewal_ar',
    language: 'ar',
    offset: 3,
    parameters: ['{name}', '{gym}', '{expires}'],
    createdAt: '2026-11-26T08:00:00.000Z',
  });
  const payload = templateMessage(rule, '201012345678', ['Ahmed', 'Morgan Club', '2026-12-01']);
  assert.equal(payload.messaging_product, 'whatsapp');
  assert.equal(payload.template.name, 'gym_renewal_ar');
  assert.equal(
    renderParameter('Hi {name} at {gym}', { id: 'm1', name: 'Ali', phone: '010', joined: '2026-01-01', expires: '2026-12-01', demo: false, archived: false, branch: 'main', consent: true }, 'GymEG'),
    'Hi Ali at GymEG'
  );
});

test('Postgres RLS isolates WPPConnect sessions, inbox, messages, and deduplication across tenants', async () => {
  const client = await bootstrapDb();
  try {
    const sql = await readFile(join(process.cwd(), 'supabase', 'migrations', '20261127000000_wppconnect_multitenant.sql'), 'utf8');
    await client.exec(sql);

    const sessionA = deriveWppSessionId('club-a', 'main');
    const sessionB = deriveWppSessionId('club-b', 'main');

    // Insert as messaging worker (simulating worker/API scoped writes)
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.messaging_worker', '1', true)");
    await client.query(
      `INSERT INTO gymos.whatsapp_provider_connections(owner_id, branch, provider, session_id, status, qr_data_url)
       VALUES('club-a', 'main', 'wppconnect', $1, 'WAITING_FOR_QR', 'data:image/png;base64,AAA'),
             ('club-b', 'main', 'wppconnect', $2, 'CONNECTED', NULL)`,
      [sessionA, sessionB]
    );
    await client.query(
      `INSERT INTO gymos.whatsapp_inbox(owner_id, id, branch, phone_hash, display_phone, contact_name)
       VALUES('club-a', 'inb-a', 'main', 'hash-a', '+201000000001', 'Member A'),
             ('club-b', 'inb-b', 'main', 'hash-b', '+201000000002', 'Member B')`
    );
    await client.query(
      `INSERT INTO gymos.whatsapp_messages(owner_id, id, inbox_id, branch, direction, provider, provider_message_id, body, status)
       VALUES('club-a', 'msg-a1', 'inb-a', 'main', 'inbound', 'wppconnect', 'wpp-msg-1', 'Secret A', 'received')`
    );

    // Duplicate provider_message_id for same tenant is rejected by unique index
    await assert.rejects(async () => {
      await client.query('SAVEPOINT sp_dup');
      try {
        await client.query(
          `INSERT INTO gymos.whatsapp_messages(owner_id, id, inbox_id, branch, direction, provider, provider_message_id, body, status)
           VALUES('club-a', 'msg-a2', 'inb-a', 'main', 'inbound', 'wppconnect', 'wpp-msg-1', 'Dup', 'received')`
        );
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT sp_dup');
        throw err;
      }
    });
    await client.query('COMMIT');

    // Verify strict RLS isolation: as club-a under gymos_app, club-b rows are invisible!
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE gymos_app');
    await client.query("SELECT set_config('app.gym_owner', 'club-a', true)");
    const connsA = (await client.query('SELECT owner_id, status FROM gymos.whatsapp_provider_connections')).rows;
    const inboxA = (await client.query('SELECT owner_id, display_phone FROM gymos.whatsapp_inbox')).rows;
    const msgsA = (await client.query('SELECT owner_id, body FROM gymos.whatsapp_messages')).rows;
    await client.query('COMMIT');

    assert.equal(connsA.length, 1);
    assert.equal(connsA[0].owner_id, 'club-a');
    assert.equal(inboxA.length, 1);
    assert.equal(inboxA[0].display_phone, '+201000000001');
    assert.equal(msgsA.length, 1);
    assert.equal(msgsA[0].body, 'Secret A');
  } finally {
    await client.close();
  }
});
