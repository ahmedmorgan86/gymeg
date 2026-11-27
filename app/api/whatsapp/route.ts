import { licenseState, CommercialError } from '../../lib/licensing';
import { createHash, randomUUID } from 'node:crypto';
import { context, readSpaceCore, readSpaceMeta, reply, sameOrigin } from '../../lib/server-workspace';
import { assertRequestTenant } from '../../lib/request-tenant';
import { withScope } from '../../lib/database';
import { whatsappPhone, whatsappRule } from '../../lib/whatsapp';
import { runWhatsApp, syncManualRemindersToWppOutbox } from '../../lib/whatsapp-server';
import { autoReplyRuleSchema, deriveWppSessionId } from '../../lib/wppconnect';
import { isFirestorePersistence } from '../../lib/firestore-db';
import { connectWhatsApp, disconnectWhatsApp, runWhatsAppFirestore, saveWhatsAppRule, whatsappEncryptionReady, whatsappSettings } from '../../lib/firestore-whatsapp';

async function access(request: Request) {
  const ctx = await context();
  if (!ctx || !['owner', 'manager'].includes(ctx.role)) throw Error('forbidden');
  assertRequestTenant(request, ctx.tenantId, Boolean(ctx.license));
  const branch = new URL(request.url).searchParams.get('branch') ?? '';
  const { state } = await (process.env.GYMOS_WHATSAPP_READS === '1' ? readSpaceMeta(ctx.owner) : readSpaceCore(ctx.owner));
  if (!state.branches.some((b) => b.id === branch) || (ctx.branches && !ctx.branches.includes(branch))) throw Error('forbidden');
  return { ctx, branch };
}

export async function GET(request: Request) {
  try {
    const { ctx, branch } = await access(request);
    if (isFirestorePersistence()) {
      return reply({
        ...await whatsappSettings(ctx.owner, branch),
        encryptionReady: whatsappEncryptionReady(),
        automaticSchedule: 'Daily; manual Run available',
        wppSupported: false,
      });
    }

    const data = await withScope(ctx.owner, async (c) => {
      const connection = (await c.query('SELECT phone_id,api_version,updated_at FROM gymos.whatsapp_connections WHERE owner_id=$1 AND branch=$2', [ctx.owner, branch])).rows[0] ?? null;
      const rules = (await c.query('SELECT payload FROM gymos.whatsapp_rules WHERE owner_id=$1 AND branch=$2', [ctx.owner, branch])).rows.map((r) => r.payload);
      const outbox = (await c.query('SELECT id,member_id,status,error,updated_at FROM gymos.whatsapp_outbox WHERE owner_id=$1 AND branch=$2 ORDER BY updated_at DESC LIMIT 100', [ctx.owner, branch])).rows;

      let wppConnection = null;
      let inbox: unknown[] = [];
      let autoReplies: unknown[] = [];
      let auditLogs: unknown[] = [];
      try {
        wppConnection = (await c.query(
          'SELECT provider, status, connected_phone, qr_data_url, qr_expires_at, last_connected_at, last_error, daily_limit, sent_today, updated_at FROM gymos.whatsapp_provider_connections WHERE owner_id=$1 AND branch=$2',
          [ctx.owner, branch]
        )).rows[0] ?? null;
        inbox = (await c.query(
          'SELECT id, member_id, display_phone, contact_name, assigned_to, status, unread_count, last_message_at FROM gymos.whatsapp_inbox WHERE owner_id=$1 AND branch=$2 ORDER BY last_message_at DESC LIMIT 50',
          [ctx.owner, branch]
        )).rows;
        autoReplies = (await c.query(
          'SELECT id, enabled, name, keywords, reply_text, welcome_text, off_hours_text, active_days, start_hour, end_hour, handoff_to_staff, cooldown_minutes FROM gymos.whatsapp_auto_replies WHERE owner_id=$1 AND branch=$2 ORDER BY updated_at DESC LIMIT 30',
          [ctx.owner, branch]
        )).rows;
        auditLogs = (await c.query(
          'SELECT id, actor, action, detail, created_at FROM gymos.whatsapp_audit_logs WHERE owner_id=$1 AND branch=$2 ORDER BY created_at DESC LIMIT 30',
          [ctx.owner, branch]
        )).rows;
      } catch {
        // Migration 20261127000000 not yet applied on DB; gracefully omit extended tables
      }

      return { connection, rules, outbox, wppConnection, inbox, autoReplies, auditLogs };
    });

    return reply({ ...data, encryptionReady: true, wppSupported: true, automaticSchedule: 'Every 5 minutes; manual Run available' });
  } catch (e) {
    if (e instanceof CommercialError) return reply({ error: e.code }, e.status);
    return reply({ error: e instanceof Error && e.message === 'forbidden' ? 'forbidden' : 'unavailable' }, e instanceof Error && e.message === 'forbidden' ? 403 : 503);
  }
}

export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) return reply({ error: 'origin' }, 403);
    const { ctx, branch } = await access(request);
    if (ctx.license && !licenseState(ctx.license).writable) return reply({ error: 'licenseReadOnly' }, 403);
    const raw = await request.text();
    if (raw.length > 20000) return reply({ error: 'limit' }, 413);
    const body = JSON.parse(raw);

    if (isFirestorePersistence()) {
      if (body.action === 'connect') {
        if (!/^[0-9]{5,30}$/.test(body.phoneId) || !/^v[0-9]{2}\.0$/.test(body.apiVersion) || typeof body.token !== 'string' || body.token.length < 20 || body.token.length > 5000) return reply({ error: 'invalid' }, 400);
        await connectWhatsApp(ctx.owner, branch, body.phoneId, body.apiVersion, body.token);
        return reply({ ok: true });
      }
      if (body.action === 'disconnect') {
        await disconnectWhatsApp(ctx.owner, branch);
        return reply({ ok: true });
      }
      if (body.action === 'rule') {
        const saved = await saveWhatsAppRule(ctx.owner, branch, body.rule);
        return saved ? reply({ ok: true }) : reply({ error: 'limit' }, 400);
      }
      if (body.action === 'run') return reply(await runWhatsAppFirestore(ctx.owner, branch));
      return reply({ error: 'postgresRequiredForWppConnect' }, 400);
    }

    // Legacy Meta Cloud API actions (preserved unchanged)
    if (body.action === 'connect') {
      if (!/^[0-9]{5,30}$/.test(body.phoneId) || !/^v[0-9]{2}\.0$/.test(body.apiVersion) || typeof body.token !== 'string' || body.token.length < 20 || body.token.length > 5000) return reply({ error: 'invalid' }, 400);
      const cipher = await withScope(ctx.owner, async (c) => (await c.query('SELECT gymos.messaging_encrypt($1,$2) AS cipher', [branch, body.token])).rows[0].cipher);
      await withScope(ctx.owner, (c) => c.query('INSERT INTO gymos.whatsapp_connections(owner_id,branch,phone_id,api_version,token_cipher) VALUES($1,$2,$3,$4,$5) ON CONFLICT(owner_id,branch) DO UPDATE SET phone_id=excluded.phone_id,api_version=excluded.api_version,token_cipher=excluded.token_cipher,updated_at=now()', [ctx.owner, branch, body.phoneId, body.apiVersion, cipher]));
      return reply({ ok: true });
    }
    if (body.action === 'disconnect') {
      await withScope(ctx.owner, async (c) => {
        await c.query('DELETE FROM gymos.whatsapp_connections WHERE owner_id=$1 AND branch=$2', [ctx.owner, branch]);
        await c.query("UPDATE gymos.whatsapp_outbox SET status='cancelled' WHERE owner_id=$1 AND branch=$2 AND status='pending'", [ctx.owner, branch]);
      });
      return reply({ ok: true });
    }
    if (body.action === 'rule') {
      const res = await withScope(ctx.owner, async (c) => {
        const previous = typeof body.rule?.id === 'string' ? (await c.query('SELECT payload FROM gymos.whatsapp_rules WHERE owner_id=$1 AND id=$2 AND branch=$3', [ctx.owner, body.rule.id, branch])).rows[0] : null;
        const rule = whatsappRule.parse({ ...body.rule, id: previous?.payload.id ?? randomUUID(), branch, createdAt: previous?.payload.createdAt ?? new Date().toISOString() });
        if (!previous) {
          const count = Number((await c.query('SELECT count(*) FROM gymos.whatsapp_rules WHERE owner_id=$1', [ctx.owner])).rows[0].count);
          if (count >= 100) return { error: 'limit', status: 400 };
        }
        await c.query('INSERT INTO gymos.whatsapp_rules(owner_id,id,branch,payload) VALUES($1,$2,$3,$4) ON CONFLICT(owner_id,id) DO UPDATE SET payload=excluded.payload WHERE gymos.whatsapp_rules.branch=excluded.branch', [ctx.owner, rule.id, branch, JSON.stringify(rule)]);
        return { ok: true, status: 200 };
      });
      if (res.error) return reply({ error: res.error }, res.status);
      return reply({ ok: true });
    }
    if (body.action === 'run') return reply(await runWhatsApp(ctx.owner, branch));

    // WPPConnect Multi-Tenant & Inbox Actions
    const sessionId = deriveWppSessionId(ctx.owner, branch);

    if (body.action === 'provider.select') {
      const provider = body.provider === 'wppconnect' || body.provider === 'manual' ? body.provider : 'meta';
      const dailyLimit = typeof body.dailyLimit === 'number' && Number.isFinite(body.dailyLimit) ? Math.min(5000, Math.max(1, Math.round(body.dailyLimit))) : 250;
      await withScope(ctx.owner, (c) =>
        c.query(
          `INSERT INTO gymos.whatsapp_provider_connections(owner_id, branch, provider, session_id, daily_limit)
           VALUES($1, $2, $3, $4, $5)
           ON CONFLICT(owner_id, branch) DO UPDATE
           SET provider = excluded.provider, daily_limit = excluded.daily_limit, updated_at = now()`,
          [ctx.owner, branch, provider, sessionId, dailyLimit]
        )
      );
      return reply({ ok: true });
    }

    if (body.action === 'wpp.connect') {
      await withScope(ctx.owner, async (c) => {
        await c.query(
          `INSERT INTO gymos.whatsapp_provider_connections(owner_id, branch, provider, session_id, status, desired_action, last_error, qr_data_url)
           VALUES($1, $2, 'wppconnect', $3, 'STARTING', 'connect', NULL, NULL)
           ON CONFLICT(owner_id, branch) DO UPDATE
           SET provider = 'wppconnect', session_id = excluded.session_id, status = 'STARTING', desired_action = 'connect', last_error = NULL, qr_data_url = NULL, updated_at = now()`,
          [ctx.owner, branch, sessionId]
        );
        await c.query(
          'INSERT INTO gymos.whatsapp_audit_logs(owner_id, id, branch, actor, action, detail) VALUES($1, $2, $3, $4, $5, $6)',
          [ctx.owner, randomUUID(), branch, ctx.user.displayName, 'wpp.connect_requested', '']
        );
      });
      return reply({ ok: true });
    }

    if (body.action === 'wpp.disconnect') {
      await withScope(ctx.owner, async (c) => {
        await c.query(
          `UPDATE gymos.whatsapp_provider_connections
           SET status = 'DISCONNECTED', desired_action = 'disconnect', qr_data_url = NULL, connected_phone = NULL, updated_at = now()
           WHERE owner_id = $1 AND branch = $2`,
          [ctx.owner, branch]
        );
        await c.query(
          "UPDATE gymos.whatsapp_outbox SET status = 'cancelled' WHERE owner_id = $1 AND branch = $2 AND provider = 'wppconnect' AND status = 'pending'",
          [ctx.owner, branch]
        );
        await c.query(
          'INSERT INTO gymos.whatsapp_audit_logs(owner_id, id, branch, actor, action, detail) VALUES($1, $2, $3, $4, $5, $6)',
          [ctx.owner, randomUUID(), branch, ctx.user.displayName, 'wpp.disconnect_requested', '']
        );
      });
      return reply({ ok: true });
    }

    if (body.action === 'wpp.test') {
      const phone = whatsappPhone(String(body.phone ?? ''));
      const text = String(body.text ?? '').trim().slice(0, 1000);
      if (!phone || !text) return reply({ error: 'invalid' }, 400);
      const id = createHash('sha256').update(JSON.stringify([ctx.owner, 'test', branch, phone, randomUUID()])).digest('hex');
      await withScope(ctx.owner, (c) =>
        c.query(
          `INSERT INTO gymos.whatsapp_outbox(owner_id, id, branch, member_id, rule_id, occurrence, status, provider, session_id, message_type, payload)
           VALUES($1, $2, $3, 'test', 'test', $4, 'pending', 'wppconnect', $5, 'test', $6)`,
          [ctx.owner, id, branch, new Date().toISOString(), sessionId, JSON.stringify({ to: phone, text })]
        )
      );
      return reply({ ok: true, id });
    }

    if (body.action === 'wpp.sendReminder') {
      const phone = whatsappPhone(String(body.phone ?? ''));
      const text = String(body.text ?? '').trim().slice(0, 1500);
      const memberId = String(body.memberId ?? '').trim().slice(0, 100);
      const templateId = String(body.templateId ?? body.kind ?? 'manual').trim().slice(0, 100);
      if (!phone || !text || !memberId) return reply({ error: 'invalid' }, 400);
      const id = createHash('sha256').update(JSON.stringify([ctx.owner, 'manual-send', branch, templateId, memberId, randomUUID()])).digest('hex');
      await withScope(ctx.owner, (c) =>
        c.query(
          `INSERT INTO gymos.whatsapp_outbox(owner_id, id, branch, member_id, rule_id, occurrence, status, provider, session_id, message_type, payload)
           VALUES($1, $2, $3, $4, $5, $6, 'pending', 'wppconnect', $7, 'rule', $8)`,
          [ctx.owner, id, branch, memberId, templateId, new Date().toISOString().slice(0, 10), sessionId, JSON.stringify({ to: phone, text })]
        )
      );
      return reply({ ok: true, id });
    }

    if (body.action === 'wpp.runReminders') {
      const synced = await syncManualRemindersToWppOutbox(ctx.owner, branch);
      const ran = await runWhatsApp(ctx.owner, branch);
      return reply({ ok: true, enqueued: synced.enqueued, sent: ran.sent });
    }

    if (body.action === 'inbox.messages') {
      const inboxId = String(body.inboxId ?? '');
      if (!inboxId) return reply({ error: 'invalid' }, 400);
      const messages = await withScope(ctx.owner, async (c) => {
        await c.query('UPDATE gymos.whatsapp_inbox SET unread_count = 0 WHERE owner_id = $1 AND id = $2 AND branch = $3', [ctx.owner, inboxId, branch]);
        return (await c.query('SELECT id, direction, provider, body, status, created_at FROM gymos.whatsapp_messages WHERE owner_id = $1 AND inbox_id = $2 AND branch = $3 ORDER BY created_at ASC LIMIT 100', [ctx.owner, inboxId, branch])).rows;
      });
      return reply({ ok: true, messages });
    }

    if (body.action === 'inbox.reply') {
      const inboxId = String(body.inboxId ?? '');
      const text = String(body.text ?? '').trim().slice(0, 2000);
      if (!inboxId || !text) return reply({ error: 'invalid' }, 400);
      const res = await withScope(ctx.owner, async (c) => {
        const conv = (await c.query('SELECT id, display_phone, member_id FROM gymos.whatsapp_inbox WHERE owner_id = $1 AND id = $2 AND branch = $3', [ctx.owner, inboxId, branch])).rows[0] as { id: string; display_phone: string; member_id: string | null } | undefined;
        if (!conv) return { error: 'notFound', status: 404 };
        const msgId = randomUUID();
        const outId = createHash('sha256').update(JSON.stringify([ctx.owner, 'reply', msgId])).digest('hex');
        await c.query(
          `INSERT INTO gymos.whatsapp_messages(owner_id, id, inbox_id, branch, direction, provider, body, status)
           VALUES($1, $2, $3, $4, 'outbound', 'wppconnect', $5, 'pending')`,
          [ctx.owner, msgId, inboxId, branch, text]
        );
        await c.query(
          `INSERT INTO gymos.whatsapp_outbox(owner_id, id, branch, member_id, rule_id, occurrence, status, provider, session_id, message_type, payload)
           VALUES($1, $2, $3, $4, 'inbox_reply', $5, 'pending', 'wppconnect', $6, 'manual_reply', $7)`,
          [ctx.owner, outId, branch, conv.member_id ?? inboxId, new Date().toISOString(), sessionId, JSON.stringify({ to: conv.display_phone, text })]
        );
        await c.query('UPDATE gymos.whatsapp_inbox SET last_message_at = now() WHERE owner_id = $1 AND id = $2', [ctx.owner, inboxId]);
        return { ok: true, status: 200 };
      });
      if ('error' in res && res.error) return reply({ error: res.error }, res.status);
      return reply({ ok: true });
    }

    if (body.action === 'inbox.assign') {
      const inboxId = String(body.inboxId ?? '');
      const assignedTo = typeof body.assignedTo === 'string' ? body.assignedTo.trim().slice(0, 120) : null;
      if (!inboxId) return reply({ error: 'invalid' }, 400);
      await withScope(ctx.owner, (c) => c.query('UPDATE gymos.whatsapp_inbox SET assigned_to = $4 WHERE owner_id = $1 AND id = $2 AND branch = $3', [ctx.owner, inboxId, branch, assignedTo || null]));
      return reply({ ok: true });
    }

    if (body.action === 'autoreply.save') {
      const parsed = autoReplyRuleSchema.safeParse(body.rule);
      if (!parsed.success) return reply({ error: 'invalid' }, 400);
      const r = parsed.data;
      const id = r.id || randomUUID();
      await withScope(ctx.owner, (c) =>
        c.query(
          `INSERT INTO gymos.whatsapp_auto_replies(owner_id, id, branch, enabled, name, keywords, reply_text, welcome_text, off_hours_text, active_days, start_hour, end_hour, handoff_to_staff, cooldown_minutes, updated_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
           ON CONFLICT(owner_id, id) DO UPDATE
           SET enabled=excluded.enabled, name=excluded.name, keywords=excluded.keywords, reply_text=excluded.reply_text, welcome_text=excluded.welcome_text, off_hours_text=excluded.off_hours_text, active_days=excluded.active_days, start_hour=excluded.start_hour, end_hour=excluded.end_hour, handoff_to_staff=excluded.handoff_to_staff, cooldown_minutes=excluded.cooldown_minutes, updated_at=now()
           WHERE gymos.whatsapp_auto_replies.branch = excluded.branch`,
          [ctx.owner, id, branch, r.enabled, r.name, r.keywords, r.replyText, r.welcomeText, r.offHoursText, r.activeDays, r.startHour, r.endHour, r.handoffToStaff, r.cooldownMinutes]
        )
      );
      return reply({ ok: true, id });
    }

    if (body.action === 'wpp.sendReminder') {
      const phone = whatsappPhone(String(body.phone ?? ''));
      const text = String(body.text ?? '').trim().slice(0, 1500);
      const memberId = String(body.memberId ?? '').trim().slice(0, 100);
      const templateId = String(body.templateId ?? body.kind ?? 'manual').trim().slice(0, 100);
      if (!phone || !text || !memberId) return reply({ error: 'invalid' }, 400);
      const id = createHash('sha256').update(JSON.stringify([ctx.owner, 'manual-send', branch, templateId, memberId, randomUUID()])).digest('hex');
      await withScope(ctx.owner, (c) =>
        c.query(
          `INSERT INTO gymos.whatsapp_outbox(owner_id, id, branch, member_id, rule_id, occurrence, status, provider, session_id, message_type, payload)
           VALUES($1, $2, $3, $4, $5, $6, 'pending', 'wppconnect', $7, 'rule', $8)`,
          [ctx.owner, id, branch, memberId, templateId, new Date().toISOString().slice(0, 10), sessionId, JSON.stringify({ to: phone, text })]
        )
      );
      return reply({ ok: true, id });
    }

    if (body.action === 'wpp.runReminders') {
      const synced = await syncManualRemindersToWppOutbox(ctx.owner, branch);
      const ran = await runWhatsApp(ctx.owner, branch);
      return reply({ ok: true, enqueued: synced.enqueued, sent: ran.sent });
    }

    if (body.action === 'autoreply.delete') {
      const id = String(body.id ?? '');
      if (!id) return reply({ error: 'invalid' }, 400);
      await withScope(ctx.owner, (c) => c.query('DELETE FROM gymos.whatsapp_auto_replies WHERE owner_id = $1 AND id = $2 AND branch = $3', [ctx.owner, id, branch]));
      return reply({ ok: true });
    }

    return reply({ error: 'invalid' }, 400);
  } catch (e) {
    if (e instanceof CommercialError) return reply({ error: e.code }, e.status);
    return reply({ error: e instanceof Error && e.message === 'forbidden' ? 'forbidden' : 'invalid' }, e instanceof Error && e.message === 'forbidden' ? 403 : 400);
  }
}
