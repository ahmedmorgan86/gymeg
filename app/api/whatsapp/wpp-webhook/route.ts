import { createHash, randomUUID } from 'node:crypto';
import { getPool } from '../../../lib/database';
import { reply, readSpaceCore } from '../../../lib/server-workspace';
import { evaluateAutoReply, verifyWorkerRequest } from '../../../lib/wppconnect';
import { whatsappPhone } from '../../../lib/whatsapp';
import { whatsappPhoneDigest } from '../../../lib/whatsapp-server';

/**
 * Authenticated WPPConnect inbound webhook forwarded by the Always-On Worker:
 * - Verifies HMAC + anti-replay timestamp
 * - Deduplicates by provider_message_id
 * - Enforces STOP/opt-out automatically
 * - Links conversation to matching member in the same club & branch
 * - Evaluates local rule-based Auto-Reply (zero paid AI) with cooldown
 */
export async function POST(request: Request) {
  const raw = await request.text();
  if (raw.length > 524288) return reply({ error: 'limit' }, 413);
  if (!verifyWorkerRequest(request, raw)) {
    return reply({ error: 'forbidden' }, 403);
  }

  try {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const event = String(payload.event ?? '');
    const sessionId = String(payload.session ?? '');
    if (!sessionId) return reply({ ok: true, ignored: true });

    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.messaging_worker','1',true)");

      const conn = (
        await client.query(
          'SELECT owner_id, branch FROM gymos.whatsapp_provider_connections WHERE session_id = $1',
          [sessionId]
        )
      ).rows[0] as { owner_id: string; branch: string } | undefined;

      if (!conn) {
        await client.query('COMMIT');
        return reply({ ok: true, ignored: true });
      }

      if (event === 'qrcode' && typeof payload.qrcode === 'string' && payload.qrcode.length > 20) {
        const qrUrl = payload.qrcode.startsWith('data:image/') ? payload.qrcode : `data:image/png;base64,${payload.qrcode}`;
        await client.query(
          `UPDATE gymos.whatsapp_provider_connections
           SET status = 'WAITING_FOR_QR', desired_action = 'none', qr_data_url = $3, qr_expires_at = now() + interval '90 seconds', updated_at = now()
           WHERE owner_id = $1 AND branch = $2`,
          [conn.owner_id, conn.branch, qrUrl]
        );
      } else if (event === 'status-find') {
        const st = String(payload.status ?? '').toLowerCase();
        if (st === 'islogged' || st === 'inchat') {
          await client.query(
            `UPDATE gymos.whatsapp_provider_connections
             SET status = 'CONNECTED', desired_action = 'none', qr_data_url = NULL, last_connected_at = now(), last_error = NULL, updated_at = now()
             WHERE owner_id = $1 AND branch = $2`,
            [conn.owner_id, conn.branch]
          );
        } else if (st === 'qrreadsuccess') {
          await client.query(
            `UPDATE gymos.whatsapp_provider_connections
             SET status = 'CONNECTING', qr_data_url = NULL, updated_at = now()
             WHERE owner_id = $1 AND branch = $2`,
            [conn.owner_id, conn.branch]
          );
        } else if (
          st === 'autoclosecalled' ||
          st === 'phonenotconnected' ||
          st === 'qrreaderror' ||
          st === 'qrreadfail' ||
          st === 'disconnectedmobile' ||
          st === 'browserclose'
        ) {
          await client.query(
            `UPDATE gymos.whatsapp_provider_connections
             SET status = 'DISCONNECTED', desired_action = 'none', qr_data_url = NULL, last_error = $3, updated_at = now()
             WHERE owner_id = $1 AND branch = $2`,
            [conn.owner_id, conn.branch, st]
          );
        }
      } else if (event === 'onmessage' && payload.fromMe !== true) {
        const rawFrom = String(payload.from ?? '').replace(/@c\.us$/i, '').replace(/\D/g, '');
        const normalized = whatsappPhone('+' + rawFrom);
        const phoneHash = normalized ? whatsappPhoneDigest(normalized) : null;
        const msgId = typeof payload.id === 'string' ? payload.id.slice(0, 200) : null;
        const bodyText = typeof payload.body === 'string' ? payload.body.slice(0, 4000) : '';
        const contactName = typeof payload.sender === 'object' && payload.sender
          ? String((payload.sender as { pushname?: unknown; name?: unknown }).pushname ?? (payload.sender as { name?: unknown }).name ?? '').slice(0, 120)
          : '';

        if (!phoneHash || !normalized) {
          await client.query('COMMIT');
          return reply({ ok: true, ignored: true });
        }

        // Deduplicate message if WPPConnect redelivers
        if (msgId) {
          const dup = await client.query(
            'SELECT 1 FROM gymos.whatsapp_messages WHERE owner_id = $1 AND provider_message_id = $2',
            [conn.owner_id, msgId]
          );
          if (dup.rowCount) {
            await client.query('COMMIT');
            return reply({ ok: true, duplicate: true });
          }
        }

        // Handle opt-out keywords automatically
        if (/^(stop|unsubscribe|cancel|end|إلغاء|الغاء|توقف)$/i.test(bodyText.trim())) {
          await client.query(
            'INSERT INTO gymos.whatsapp_optouts(owner_id, phone_hash) VALUES($1, $2) ON CONFLICT DO NOTHING',
            [conn.owner_id, phoneHash]
          );
        }

        // Match member safely within this tenant & branch only
        let matchedMemberId: string | null = null;
        let gymName = 'GymEG';
        let branchName = conn.branch;
        let timeZone = 'Africa/Cairo';
        try {
          const { state } = await readSpaceCore(conn.owner_id);
          gymName = state.settings.name || gymName;
          timeZone = state.settings.timezone || timeZone;
          branchName = state.branches.find((b) => b.id === conn.branch)?.name ?? branchName;
          const mem = state.members.find(
            (m) => m.branch === conn.branch && !m.archived && !m.demo && whatsappPhone(m.phone) === normalized
          );
          if (mem) matchedMemberId = mem.id;
        } catch {
          // Proceed even if core read is deferred
        }

        const existingInbox = (
          await client.query(
            'SELECT id, last_auto_reply_at FROM gymos.whatsapp_inbox WHERE owner_id = $1 AND branch = $2 AND phone_hash = $3',
            [conn.owner_id, conn.branch, phoneHash]
          )
        ).rows[0] as { id: string; last_auto_reply_at: string | null } | undefined;

        const inboxId = existingInbox?.id ?? randomUUID();
        const isFirstMessage = !existingInbox;

        await client.query(
          `INSERT INTO gymos.whatsapp_inbox(owner_id, id, branch, member_id, phone_hash, display_phone, contact_name, unread_count, last_message_at)
           VALUES($1, $2, $3, $4, $5, $6, $7, 1, now())
           ON CONFLICT (owner_id, branch, phone_hash) DO UPDATE
           SET member_id = COALESCE(excluded.member_id, gymos.whatsapp_inbox.member_id),
               contact_name = CASE WHEN excluded.contact_name <> '' THEN excluded.contact_name ELSE gymos.whatsapp_inbox.contact_name END,
               unread_count = gymos.whatsapp_inbox.unread_count + 1,
               last_message_at = now()`,
          [conn.owner_id, inboxId, conn.branch, matchedMemberId, phoneHash, normalized, contactName]
        );

        await client.query(
          `INSERT INTO gymos.whatsapp_messages(owner_id, id, inbox_id, branch, direction, provider, provider_message_id, body, status)
           VALUES($1, $2, $3, $4, 'inbound', 'wppconnect', $5, $6, 'received')`,
          [conn.owner_id, randomUUID(), inboxId, conn.branch, msgId, bodyText]
        );

        // Evaluate local rule-based Auto-Reply
        const optedOut = (await client.query('SELECT gymos.whatsapp_opted_out($1,$2) AS out', [conn.owner_id, phoneHash])).rows[0]?.out === true;
        if (!optedOut) {
          const autoRules = (
            await client.query('SELECT * FROM gymos.whatsapp_auto_replies WHERE owner_id = $1 AND branch = $2 AND enabled', [
              conn.owner_id,
              conn.branch,
            ])
          ).rows;
          const match = evaluateAutoReply({
            rules: autoRules,
            inboundText: bodyText,
            isFirstMessage,
            lastAutoReplyAt: existingInbox?.last_auto_reply_at ?? null,
            nowIso: new Date().toISOString(),
            timeZone,
            vars: {
              name: contactName || normalized,
              gym: gymName,
              branch: branchName,
              date: new Date().toISOString().slice(0, 10),
            },
          });

          if (match) {
            const outId = createHash('sha256')
              .update(JSON.stringify([conn.owner_id, 'autoreply', inboxId, msgId ?? Date.now()]))
              .digest('hex');
            await client.query(
              `INSERT INTO gymos.whatsapp_outbox(owner_id, id, branch, member_id, rule_id, occurrence, status, provider, session_id, message_type, payload)
               VALUES($1, $2, $3, $4, $5, $6, 'pending', 'wppconnect', $7, 'auto_reply', $8)
               ON CONFLICT DO NOTHING`,
              [
                conn.owner_id,
                outId,
                conn.branch,
                matchedMemberId ?? inboxId,
                match.matchedRuleId,
                new Date().toISOString(),
                sessionId,
                JSON.stringify({ to: normalized, text: match.replyText }),
              ]
            );
            await client.query(
              'UPDATE gymos.whatsapp_inbox SET last_auto_reply_at = now() WHERE owner_id = $1 AND id = $2',
              [conn.owner_id, inboxId]
            );
          }
        }
      } else if (event === 'onack' && typeof payload.id === 'string') {
        const ackMap: Record<number, string> = { 1: 'sent', 2: 'delivered', 3: 'read' };
        const ackStatus = ackMap[Number(payload.ack)] ?? null;
        if (ackStatus) {
          await client.query(
            'UPDATE gymos.whatsapp_messages SET status = $3 WHERE owner_id = $1 AND provider_message_id = $2',
            [conn.owner_id, payload.id, ackStatus]
          );
        }
      }

      await client.query('COMMIT');
      return reply({ ok: true });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch {
    return reply({ error: 'unavailable' }, 503);
  }
}
