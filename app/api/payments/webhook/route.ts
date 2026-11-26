import { randomUUID } from 'node:crypto';
import { applyOperation, dayAt } from '../../../lib/domain';
import { verifyPaymentIntent, verifyWebhookSignature } from '../../../lib/payment-gateway';
import { persistSpace } from '../../../lib/entity-store';
import { readSpace, reply } from '../../../lib/server-workspace';

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    if (raw.length > 65536) return reply({ error: 'limit' }, 413);

    const sigHeader = request.headers.get('x-gymeg-webhook-signature');
    const webhookSecret = process.env.PAYMENT_WEBHOOK_SECRET || process.env.CRON_SECRET;
    if (!verifyWebhookSignature(raw, sigHeader, webhookSecret)) {
      return reply({ error: 'forbidden' }, 403);
    }

    const body = JSON.parse(raw) as {
      intent?: string;
      status?: string;
      paidMinor?: number;
      transactionId?: string;
    };
    if (body.status !== 'paid' || typeof body.intent !== 'string') {
      return reply({ ok: true, ignored: true });
    }

    const intent = verifyPaymentIntent(body.intent);
    if (!intent) return reply({ error: 'invalidIntent' }, 400);
    if (typeof body.paidMinor === 'number' && body.paidMinor < intent.amountMinor) {
      return reply({ error: 'underpaid' }, 400);
    }

    const current = await readSpace(intent.owner);
    const receiptKey = `pay:${intent.reference}`;
    if (current.state.receipts.some((r) => r.id === receiptKey)) {
      return reply({ ok: true, duplicate: true, reference: intent.reference });
    }

    const now = new Date().toISOString();
    const today = dayAt(now, current.state.settings.timezone);
    const nextState = applyOperation(
      current.state,
      {
        type: 'plan.assign',
        branch: intent.branch,
        id: intent.memberId,
        plan: intent.planId,
        start: today,
        due: today,
        paid: intent.amountMinor,
        method: intent.provider === 'instapay' ? 'transfer' : 'card',
      },
      now,
      `Online (${intent.provider}) #${body.transactionId || intent.reference}`,
      () => randomUUID()
    );
    nextState.receipts.push({ id: receiptKey, digest: String(body.transactionId || intent.reference) });
    if (nextState.receipts.length > 1000) nextState.receipts.shift();

    const saved = await persistSpace(intent.owner, current, nextState);
    if (!saved) return reply({ error: 'conflict' }, 409);

    return reply({ ok: true, reference: intent.reference, renewed: true });
  } catch {
    return reply({ error: 'unavailable' }, 503);
  }
}
