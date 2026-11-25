import 'server-only';
import type { ChatGPTUser } from '../chatgpt-auth';
import { commercialTransaction } from './commercial';
import {
  canAccessSupportRequest,
  newSupportRequestId,
  SupportRequestError,
  supportRequestUpdateRecipient,
  type SupportRequest,
  type SupportRequestStatus,
} from './support-requests';

type TicketRow = {
  id: string;
  requester: string;
  assignee: string | null;
  title: string;
  status: SupportRequestStatus;
  updated_at: Date | string;
};

type MessageRow = {
  id: string;
  author: string;
  body: string;
  at: Date | string;
};

type UpdateRow = {
  id: string;
  request_id: string;
  type: 'claim' | 'reply' | 'resolve';
  at: Date | string;
};

const iso = (value: Date | string) => (value instanceof Date ? value.toISOString() : String(value));

const toTicket = (row: TicketRow): SupportRequest & { id: string } => ({
  id: row.id,
  requester: row.requester,
  assignee: row.assignee,
  title: row.title,
  status: row.status,
  updatedAt: iso(row.updated_at),
});

export async function pgListSupportUpdates(user: ChatGPTUser, platformView: boolean) {
  return commercialTransaction(user, async (client, platform) => {
    if (platformView && !platform) throw new SupportRequestError('forbidden', 403);
    const { rows } = await client.query<UpdateRow>(
      `SELECT id, request_id, type, at
       FROM gymos.support_request_updates
       WHERE recipient = $1
       ORDER BY at DESC
       LIMIT 15`,
      [user.userId],
    );
    return rows.map(row => ({ id: row.id, requestId: row.request_id, type: row.type, at: iso(row.at) }));
  });
}

export async function pgListSupportRequests(user: ChatGPTUser, platformView: boolean) {
  return commercialTransaction(user, async (client, platform) => {
    if (platformView && !platform) throw new SupportRequestError('forbidden', 403);
    const { rows } = platformView
      ? await client.query<TicketRow>(
          `SELECT id, requester, assignee, title, status, updated_at
           FROM gymos.support_requests
           ORDER BY updated_at DESC
           LIMIT 100`,
        )
      : await client.query<TicketRow>(
          `SELECT id, requester, assignee, title, status, updated_at
           FROM gymos.support_requests
           WHERE requester = $1
           ORDER BY updated_at DESC
           LIMIT 100`,
          [user.userId],
        );
    return rows.map(toTicket);
  });
}

export async function pgGetSupportThread(user: ChatGPTUser, platformView: boolean, requestId: string) {
  return commercialTransaction(user, async (client, platform) => {
    if (platformView && !platform) throw new SupportRequestError('forbidden', 403);
    const ticketRow = (
      await client.query<TicketRow>(
        `SELECT id, requester, assignee, title, status, updated_at
         FROM gymos.support_requests
         WHERE id = $1`,
        [requestId],
      )
    ).rows[0];
    if (!ticketRow) throw new SupportRequestError('notFound', 404);
    const ticket = toTicket(ticketRow);
    if (!canAccessSupportRequest(ticket, { id: user.userId, platform: platformView && platform }, 'read')) {
      throw new SupportRequestError('notFound', 404);
    }
    const { rows } = await client.query<MessageRow>(
      `SELECT id, author, body, at
       FROM gymos.support_request_messages
       WHERE request_id = $1
       ORDER BY at DESC
       LIMIT 100`,
      [requestId],
    );
    return {
      request: ticket,
      messages: rows.map(row => ({ id: row.id, author: row.author, text: row.body, at: iso(row.at) })).reverse(),
      self: user.userId,
    };
  });
}

export async function pgCreateSupportRequest(
  user: ChatGPTUser,
  input: { title: string; message: string; clientRequestId?: string },
) {
  return commercialTransaction(user, async client => {
    if (input.clientRequestId) {
      const existing = (
        await client.query<{ id: string }>(
          `SELECT id FROM gymos.support_requests WHERE requester = $1 AND client_request_id = $2`,
          [user.userId, input.clientRequestId],
        )
      ).rows[0];
      if (existing) return { id: existing.id, created: false as const };
    }
    const recentCount = Number(
      (
        await client.query<{ count: string }>(
          `SELECT count(*) AS count FROM gymos.support_requests
           WHERE requester = $1 AND created_at > now() - interval '10 minutes'`,
          [user.userId],
        )
      ).rows[0]?.count ?? 0,
    );
    if (recentCount >= 5) throw new SupportRequestError('rateLimit', 429);

    const openCount = Number(
      (
        await client.query<{ count: string }>(
          `SELECT count(*) AS count FROM gymos.support_requests
           WHERE requester = $1 AND status <> 'resolved'`,
          [user.userId],
        )
      ).rows[0]?.count ?? 0,
    );
    if (openCount >= 25) throw new SupportRequestError('limit', 429);

    const requestId = newSupportRequestId();
    const messageId = newSupportRequestId();
    const now = new Date().toISOString();
    await client.query(
      `INSERT INTO gymos.support_requests (id, requester, assignee, title, status, client_request_id, created_at, updated_at)
       VALUES ($1, $2, NULL, $3, 'open', $4, $5, $5)`,
      [requestId, user.userId, input.title, input.clientRequestId ?? null, now],
    );
    await client.query(
      `INSERT INTO gymos.support_request_messages (id, request_id, author, body, at)
       VALUES ($1, $2, $3, $4, $5)`,
      [messageId, requestId, user.userId, input.message, now],
    );
    return { id: requestId, created: true as const };
  });
}

export async function pgActOnSupportRequest(
  user: ChatGPTUser,
  input: { action: 'reply'; id: string; message: string } | { action: 'claim' | 'resolve'; id: string },
) {
  return commercialTransaction(user, async (client, platform) => {
    const ticketRow = (
      await client.query<TicketRow>(
        `SELECT id, requester, assignee, title, status, updated_at
         FROM gymos.support_requests
         WHERE id = $1`,
        [input.id],
      )
    ).rows[0];
    if (!ticketRow) throw new SupportRequestError('notFound', 404);
    const ticket = toTicket(ticketRow);
    const actor = { id: user.userId, platform };
    if (!canAccessSupportRequest(ticket, actor, 'read')) throw new SupportRequestError('notFound', 404);
    if (!canAccessSupportRequest(ticket, actor, input.action)) throw new SupportRequestError('forbidden', 403);

    const now = new Date().toISOString();
    if (input.action === 'reply') {
      const updated = await client.query(
        `UPDATE gymos.support_requests SET updated_at = $2 WHERE id = $1 AND status <> 'resolved'`,
        [input.id, now],
      );
      if (!updated.rowCount) throw new SupportRequestError('forbidden', 403);
      await client.query(
        `INSERT INTO gymos.support_request_messages (id, request_id, author, body, at)
         VALUES ($1, $2, $3, $4, $5)`,
        [newSupportRequestId(), input.id, actor.id, input.message, now],
      );
    } else if (input.action === 'claim') {
      const claimed = await client.query(
        `UPDATE gymos.support_requests
         SET assignee = $2, status = 'in_progress', updated_at = $3
         WHERE id = $1 AND assignee IS NULL AND status = 'open'`,
        [input.id, actor.id, now],
      );
      if (!claimed.rowCount) throw new SupportRequestError('forbidden', 403);
    } else {
      const resolved = await client.query(
        `UPDATE gymos.support_requests
         SET status = 'resolved', updated_at = $2
         WHERE id = $1 AND assignee = $3 AND status = 'in_progress'`,
        [input.id, now, actor.id],
      );
      if (!resolved.rowCount) throw new SupportRequestError('forbidden', 403);
    }

    const recipient = supportRequestUpdateRecipient(ticket, actor.id, input.action);
    if (recipient) {
      await client.query(
        `INSERT INTO gymos.support_request_updates (id, recipient, request_id, type, at)
         VALUES ($1, $2, $3, $4, $5)`,
        [newSupportRequestId(), recipient, input.id, input.action, now],
      );
    }
    return { id: input.id, recipient };
  });
}
