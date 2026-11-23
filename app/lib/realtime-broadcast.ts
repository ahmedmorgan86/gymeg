import type {PoolClient} from 'pg';
import {getPool} from './database';

export interface BroadcastPayload {
  revision: number;
  tenantId: string;
  actor?: string;
  type?: string;
  timestamp: string;
}

/**
 * Broadcasts a lightweight revision notification to the gym's private channel.
 */
export async function sendRealtimeBroadcast(
  tenantId: string,
  event: string,
  payload: BroadcastPayload
): Promise<boolean> {
  const url = process.env.REALTIME_BROADCAST_URL;
  const key = process.env.REALTIME_BROADCAST_KEY;

  if (!url || !key) {
    // Graceful skip in test / offline environments
    return false;
  }

  const endpoint = `${url.replace(/\/+$/, '')}/realtime/v1/api/broadcast`;
  const topic = `club:${tenantId}:workspace`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messages: [
          {
            topic,
            event,
            payload
          }
        ]
      }),
      signal: AbortSignal.timeout(3500)
    });

    return res.ok;
  } catch (err) {
    // Non-fatal: Realtime is best-effort push notification. Durable event log guarantees recovery.
    return false;
  }
}

/**
 * Flushes unprocessed outbox messages for a gym owner.
 * Typically called after the database transaction commits.
 */
export async function processWorkspaceOutbox(owner: string): Promise<number> {
  let processedCount = 0;
  try {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.gym_owner',$1,true)", [owner]);

      const messages = (await client.query(
        `SELECT id, tenant_id, channel, event, payload 
         FROM gymos.workspace_outbox 
         WHERE owner_id = $1 AND processed_at IS NULL 
         ORDER BY created_at ASC LIMIT 20 
         FOR UPDATE SKIP LOCKED`,
        [owner]
      )).rows;

      if (!messages.length) {
        await client.query('COMMIT');
        return 0;
      }

      for (const msg of messages) {
        const payload: BroadcastPayload = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
        await sendRealtimeBroadcast(msg.tenant_id, msg.event, payload);
        await client.query(
          `UPDATE gymos.workspace_outbox 
           SET processed_at = now() 
           WHERE id = $1 AND owner_id = $2`,
          [msg.id, owner]
        );
        processedCount++;
      }

      // Housekeeping: clean up old processed outbox entries (> 2 hours old)
      await client.query(
        `DELETE FROM gymos.workspace_outbox 
         WHERE owner_id = $1 AND processed_at < now() - interval '2 hours'`,
        [owner]
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch {
    // Logging or monitoring hook
  }
  return processedCount;
}
