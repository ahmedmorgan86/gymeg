import { getPool } from '../../../../lib/database';
import { reply } from '../../../../lib/server-workspace';
import { verifyWorkerRequest } from '../../../../lib/wppconnect';
import { whatsappPhoneDigest } from '../../../../lib/whatsapp-server';

/**
 * Always-On Worker Pull endpoint:
 * - Returns pending session lifecycle commands (connect / disconnect / status)
 * - Atomically claims due WPPConnect outbox jobs (respecting opt-outs & per-club daily limits)
 */
export async function GET(request: Request) {
  if (!verifyWorkerRequest(request, '')) {
    return reply({ error: 'forbidden' }, 403);
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.messaging_worker','1',true)");

    const sessionCommands = (
      await client.query(`
        SELECT owner_id AS "ownerId", branch, session_id AS "sessionId", desired_action AS action
        FROM gymos.whatsapp_provider_connections
        WHERE provider = 'wppconnect'
          AND (
            desired_action <> 'none'
            OR (status IN ('STARTING', 'WAITING_FOR_QR', 'CONNECTING', 'RECONNECTING') AND updated_at < now() - interval '20 seconds')
          )
        ORDER BY updated_at ASC
        LIMIT 20
      `)
    ).rows;

    const jobs = (
      await client.query(`
        SELECT o.owner_id, o.id, o.branch, o.member_id, o.payload, c.session_id, c.daily_limit, c.sent_today, c.sent_day
        FROM gymos.whatsapp_outbox o
        JOIN gymos.whatsapp_provider_connections c
          ON c.owner_id = o.owner_id AND c.branch = o.branch
        WHERE o.provider = 'wppconnect'
          AND o.status = 'pending'
          AND o.scheduled_at <= now()
          AND c.provider = 'wppconnect'
          AND c.status = 'CONNECTED'
        ORDER BY o.scheduled_at ASC
        FOR UPDATE OF o SKIP LOCKED
        LIMIT 20
      `)
    ).rows;

    const today = new Date().toISOString().slice(0, 10);
    const outboxJobs: Array<{ ownerId: string; id: string; sessionId: string; to: string; text: string }> = [];

    for (const j of jobs) {
      const sentToday = j.sent_day === today ? Number(j.sent_today || 0) : 0;
      if (sentToday >= Number(j.daily_limit || 250)) {
        continue;
      }

      const to = String(j.payload?.to ?? '');
      const text = String(j.payload?.text ?? '');
      const phoneDigest = to ? whatsappPhoneDigest(to) : null;
      const optedOut = phoneDigest
        ? (await client.query('SELECT gymos.whatsapp_opted_out($1,$2) AS out', [j.owner_id, phoneDigest])).rows[0]?.out === true
        : false;

      if (optedOut || !to || !text) {
        await client.query(
          "UPDATE gymos.whatsapp_outbox SET status='cancelled', error_code='opted_out_or_invalid', updated_at=now() WHERE owner_id=$1 AND id=$2",
          [j.owner_id, j.id]
        );
        continue;
      }

      await client.query(
        "UPDATE gymos.whatsapp_outbox SET status='sending', session_id=$3, attempted_at=now(), updated_at=now() WHERE owner_id=$1 AND id=$2",
        [j.owner_id, j.id, j.session_id]
      );
      outboxJobs.push({
        ownerId: j.owner_id,
        id: j.id,
        sessionId: j.session_id,
        to,
        text,
      });
    }

    await client.query('COMMIT');
    return reply({ sessionCommands, outboxJobs });
  } catch {
    await client.query('ROLLBACK');
    return reply({ error: 'unavailable' }, 503);
  } finally {
    client.release();
  }
}
