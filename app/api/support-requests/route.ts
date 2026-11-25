import { z } from 'zod';
import { getChatGPTUser } from '../../chatgpt-auth';
import { getFirestoreDb, isFirestorePersistence } from '../../lib/firestore-db';
import { platformAuthority } from '../../lib/platform-authority';
import {
  pgActOnSupportRequest,
  pgCreateSupportRequest,
  pgGetSupportThread,
  pgListSupportRequests,
  pgListSupportUpdates,
} from '../../lib/postgres-support-requests';
import { reply, sameOrigin } from '../../lib/server-workspace';
import {
  canAccessSupportRequest,
  SUPPORT_REQUEST_ID_RE,
  SupportRequestError,
  supportRequestUpdateRecipient,
  type SupportRequest,
} from '../../lib/support-requests';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const id = z.string().regex(SUPPORT_REQUEST_ID_RE);
const message = z.string().trim().min(1).max(2000);
const clientRequestId = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i).optional();
const command = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), title: z.string().trim().min(3).max(120), message, clientRequestId }).strict(),
  z.object({ action: z.literal('reply'), id, message }).strict(),
  z.object({ action: z.literal('claim'), id }).strict(),
  z.object({ action: z.literal('resolve'), id }).strict(),
]);

function failure(error: unknown) {
  if (error instanceof SupportRequestError) return reply({ error: error.code }, error.status);
  if (error instanceof z.ZodError || error instanceof SyntaxError) return reply({ error: 'invalid' }, 400);
  console.error('[support-requests]', error instanceof Error ? error.message : 'unavailable');
  return reply({ error: 'unavailable' }, 503);
}

export async function GET(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user) return reply({ error: 'auth' }, 401);
    const url = new URL(request.url);
    const platform = url.searchParams.get('platform') === '1';
    const updates = url.searchParams.get('updates') === '1';
    const target = url.searchParams.get('id');

    if (!isFirestorePersistence()) {
      if (updates) return reply({ updates: await pgListSupportUpdates(user, platform) });
      if (target === null) return reply({ requests: await pgListSupportRequests(user, platform) });
      return reply(await pgGetSupportThread(user, platform, id.parse(target)));
    }

    if (platform && !(await platformAuthority(user))) return reply({ error: 'forbidden' }, 403);
    const db = getFirestoreDb();
    if (updates) {
      const events = await db.collection('gym_support_request_inboxes').doc(user.userId)
        .collection('updates').orderBy('at', 'desc').limit(15).get();
      return reply({ updates: events.docs.map(event => ({ id: event.id, ...event.data() })) });
    }
    const collection = db.collection('gym_support_requests');
    if (target === null) {
      const query = platform ? collection : collection.where('requester', '==', user.userId);
      const rows = (await query.limit(100).get()).docs.map(doc => ({ id: doc.id, ...doc.data() as SupportRequest }));
      return reply({ requests: rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) });
    }
    const ref = collection.doc(id.parse(target));
    const doc = await ref.get();
    const ticket = doc.data() as SupportRequest | undefined;
    if (!ticket || !canAccessSupportRequest(ticket, { id: user.userId, platform }, 'read')) return reply({ error: 'notFound' }, 404);
    const messages = (await ref.collection('messages').orderBy('at', 'desc').limit(100).get()).docs
      .map(row => ({ id: row.id, ...row.data() })).reverse();
    return reply({ request: { id: doc.id, ...ticket }, messages, self: user.userId });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return reply({ error: 'origin' }, 403);
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return reply({ error: 'invalid' }, 415);
  try {
    const user = await getChatGPTUser();
    if (!user) return reply({ error: 'auth' }, 401);
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 12000) return reply({ error: 'limit' }, 413);
    const input = command.parse(JSON.parse(raw));

    if (!isFirestorePersistence()) {
      if (input.action === 'create') {
        const created = await pgCreateSupportRequest(user, input);
        return reply({ id: created.id }, created.created ? 201 : 200);
      }
      const result = await pgActOnSupportRequest(user, input);
      return reply({ id: result.id });
    }

    const db = getFirestoreDb();
    const collection = db.collection('gym_support_requests');
    const at = new Date().toISOString();
    if (input.action === 'create') {
      const existingSnap = await collection.where('requester', '==', user.userId).limit(30).get();
      if (input.clientRequestId) {
        const dup = existingSnap.docs.find(d => d.data().clientRequestId === input.clientRequestId);
        if (dup) return reply({ id: dup.id }, 200);
      }
      const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const recent = existingSnap.docs.filter(d => (d.data().createdAt ?? d.data().updatedAt ?? '') > cutoff).length;
      if (recent >= 5) return reply({ error: 'rateLimit' }, 429);
      if (existingSnap.docs.filter(d => d.data().status !== 'resolved').length >= 25) return reply({ error: 'limit' }, 429);

      const ref = collection.doc();
      const batch = db.batch();
      batch.create(ref, {
        requester: user.userId,
        assignee: null,
        title: input.title,
        status: 'open',
        updatedAt: at,
        createdAt: at,
        ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
      });
      batch.create(ref.collection('messages').doc(), { author: user.userId, text: input.message, at });
      await batch.commit();
      return reply({ id: ref.id }, 201);
    }

    const ref = collection.doc(input.id);
    const actor = { id: user.userId, platform: await platformAuthority(user) };
    const result = await db.runTransaction(async tx => {
      const ticket = (await tx.get(ref)).data() as SupportRequest | undefined;
      if (!ticket || !canAccessSupportRequest(ticket, actor, 'read')) return 'notFound';
      if (!canAccessSupportRequest(ticket, actor, input.action)) return 'forbidden';
      if (input.action === 'reply') {
        tx.create(ref.collection('messages').doc(), { author: actor.id, text: input.message, at });
        tx.update(ref, { updatedAt: at });
      } else if (input.action === 'claim') {
        tx.update(ref, { assignee: actor.id, status: 'in_progress', updatedAt: at });
      } else {
        tx.update(ref, { status: 'resolved', updatedAt: at });
      }
      const recipient = supportRequestUpdateRecipient(ticket, actor.id, input.action);
      if (recipient) {
        const update = db.collection('gym_support_request_inboxes').doc(recipient).collection('updates').doc();
        tx.create(update, { requestId: ref.id, type: input.action, at });
      }
      return 'ok';
    });
    if (result === 'notFound') return reply({ error: result }, 404);
    if (result === 'forbidden') return reply({ error: result }, 403);
    return reply({ id: ref.id });
  } catch (error) {
    return failure(error);
  }
}
