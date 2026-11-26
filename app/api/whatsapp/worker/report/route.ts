import { randomUUID } from 'node:crypto';
import { getPool } from '../../../../lib/database';
import { reply } from '../../../../lib/server-workspace';
import { verifyWorkerRequest, WPP_SESSION_STATES } from '../../../../lib/wppconnect';

/**
 * Always-On Worker Report endpoint:
 * Updates session QR/status or outbox delivery result (sent / failed / unknown).
 */
export async function POST(request: Request) {
  const raw = await request.text();
  if (!verifyWorkerRequest(request, raw)) {
    return reply({ error: 'forbidden' }, 403);
  }

  try {
    const body = JSON.parse(raw) as Record<string, unknown>;
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.messaging_worker','1',true)");

      if (body.kind === 'session') {
        const ownerId = String(body.ownerId ?? '');
        const branch = String(body.branch ?? '');
        const sessionId = String(body.sessionId ?? '');
        const status = String(body.status ?? 'FAILED');
        if (!ownerId || !branch || !WPP_SESSION_STATES.includes(status as (typeof WPP_SESSION_STATES)[number])) {
          await client.query('ROLLBACK');
          return reply({ error: 'invalid' }, 400);
        }

        const qrDataUrl = typeof body.qrDataUrl === 'string' && body.qrDataUrl.startsWith('data:image/') ? body.qrDataUrl : null;
        const connectedPhone = typeof body.connectedPhone === 'string' ? body.connectedPhone.slice(0, 40) : null;
        const lastError = typeof body.error === 'string' ? body.error.slice(0, 200) : null;

        await client.query(
          `UPDATE gymos.whatsapp_provider_connections
           SET status = $4,
               desired_action = CASE WHEN $4 IN ('CONNECTED', 'DISCONNECTED', 'FAILED') THEN 'none' ELSE desired_action END,
               qr_data_url = CASE WHEN $4 = 'WAITING_FOR_QR' THEN COALESCE($5, qr_data_url) ELSE NULL END,
               qr_expires_at = CASE WHEN $4 = 'WAITING_FOR_QR' THEN now() + interval '90 seconds' ELSE NULL END,
               connected_phone = COALESCE($6, CASE WHEN $4 = 'DISCONNECTED' THEN NULL ELSE connected_phone END),
               last_connected_at = CASE WHEN $4 = 'CONNECTED' THEN now() ELSE last_connected_at END,
               last_error = $7,
               updated_at = now()
           WHERE owner_id = $1 AND branch = $2 AND session_id = $3`,
          [ownerId, branch, sessionId, status, qrDataUrl, connectedPhone, lastError]
        );

        await client.query(
          'INSERT INTO gymos.whatsapp_audit_logs(owner_id, id, branch, actor, action, detail) VALUES($1, $2, $3, $4, $5, $6)',
          [ownerId, randomUUID(), branch, 'wpp-worker', `session.${status.toLowerCase()}`, lastError ?? connectedPhone ?? '']
        );
      } else if (body.kind === 'outbox') {
        const ownerId = String(body.ownerId ?? '');
        const jobId = String(body.jobId ?? '');
        const status = body.status === 'sent' || body.status === 'failed' ? body.status : 'unknown';
        const providerMessageId = typeof body.providerMessageId === 'string' ? body.providerMessageId.slice(0, 200) : null;
        const errorCode = typeof body.errorCode === 'string' ? body.errorCode.slice(0, 80) : null;

        const out = await client.query(
          `UPDATE gymos.whatsapp_outbox
           SET status = $3,
               provider_id = COALESCE($4, provider_id),
               error = $5,
               error_code = $5,
               sent_at = CASE WHEN $3 = 'sent' THEN now() ELSE sent_at END,
               updated_at = now()
           WHERE owner_id = $1 AND id = $2
           RETURNING branch`,
          [ownerId, jobId, status, providerMessageId, errorCode]
        );

        if (status === 'sent' && out.rows[0]?.branch) {
          const today = new Date().toISOString().slice(0, 10);
          await client.query(
            `UPDATE gymos.whatsapp_provider_connections
             SET sent_today = CASE WHEN sent_day = $3 THEN sent_today + 1 ELSE 1 END,
                 sent_day = $3,
                 updated_at = now()
             WHERE owner_id = $1 AND branch = $2`,
            [ownerId, out.rows[0].branch, today]
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
