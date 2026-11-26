import { randomUUID } from 'node:crypto';
import { getPool } from '../../../lib/database';
import { applyOperation, dayAt } from '../../../lib/domain';
import { persistSpace } from '../../../lib/entity-store';
import { licenseGrant, type License, type LicenseMode } from '../../../lib/licensing';
import { decryptGatewaySecret, verifyPaymentIntent, verifyWebhookSignature } from '../../../lib/payment-gateway';
import { readSpace, reply } from '../../../lib/server-workspace';

export async function POST(request: Request) {
  try {
    const raw = await request.text();
    if (raw.length > 65536) return reply({ error: 'limit' }, 413);

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

    const sigHeader = request.headers.get('x-gymeg-webhook-signature');

    if (intent.kind === 'platform_license') {
      const platformSecret = process.env.PAYMOB_HMAC_SECRET || process.env.PAYMENT_WEBHOOK_SECRET || process.env.CRON_SECRET;
      if (!verifyWebhookSignature(raw, sigHeader, platformSecret)) {
        return reply({ error: 'forbidden' }, 403);
      }
      if (!intent.tenantId || !intent.orderId) return reply({ error: 'invalidIntent' }, 400);

      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.platform','1',true), set_config('app.actor','paymob-webhook',true)");
        const ord = (await client.query('SELECT * FROM gymos.activation_requests WHERE id=$1 FOR UPDATE', [intent.orderId])).rows[0] as { id: string; tenant_id: string; mode: LicenseMode; status: string } | undefined;
        if (!ord || ord.status === 'approved') {
          await client.query('COMMIT');
          return reply({ ok: true, duplicate: true, reference: intent.reference });
        }
        const lic = (await client.query('SELECT * FROM gymos.tenant_licenses WHERE tenant_id=$1 FOR UPDATE', [ord.tenant_id])).rows[0] as License;
        const grant = licenseGrant(lic, ord.mode, new Date().toISOString());
        await client.query('UPDATE gymos.tenant_licenses SET mode=$1,status=$2,starts_at=$3,ends_at=$4,maintenance_until=$5,revision=revision+1,updated_at=now() WHERE tenant_id=$6', [
          grant.mode,
          'active',
          grant.starts_at,
          grant.ends_at,
          grant.maintenance_until,
          ord.tenant_id,
        ]);
        await client.query("UPDATE gymos.activation_requests SET status='approved',transfer_ref=$1,paid_minor=$2,reviewed_at=now() WHERE id=$3", [
          String(body.transactionId || intent.reference),
          intent.amountMinor,
          ord.id,
        ]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      return reply({ ok: true, reference: intent.reference, licenseActivated: true });
    }

    // Member subscription renewal: verify with this club's own HMAC secret (or fallback webhook secret)
    if (!intent.memberId || !intent.branch) return reply({ error: 'invalidIntent' }, 400);
    const current = await readSpace(intent.owner);
    const clubHmac = decryptGatewaySecret(current.state.settings.paymentGateway?.paymobHmacSecretEnc) || process.env.PAYMENT_WEBHOOK_SECRET || process.env.CRON_SECRET;
    if (!verifyWebhookSignature(raw, sigHeader, clubHmac)) {
      return reply({ error: 'forbidden' }, 403);
    }

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
