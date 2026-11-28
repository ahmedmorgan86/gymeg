import { randomUUID } from 'node:crypto';
import { getChatGPTUser } from '../../chatgpt-auth';
import { getPool } from '../../lib/database';
import { createGatewayCheckout, signPaymentIntent, type CheckoutIntent } from '../../lib/payment-gateway';
import { reply, sameOrigin } from '../../lib/server-workspace';

/** Platform-level Paymob checkout for gym owners purchasing or renewing their GymEG app license. */
export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) return reply({ error: 'origin' }, 403);
    const user = await getChatGPTUser();
    if (!user) return reply({ error: 'auth' }, 401);

    const raw = await request.text();
    if (raw.length > 2048) return reply({ error: 'limit' }, 413);
    const body = JSON.parse(raw) as { tenantId?: unknown; orderId?: unknown };
    if (typeof body.tenantId !== 'string' || typeof body.orderId !== 'string') {
      return reply({ error: 'invalid' }, 400);
    }

    const client = await getPool().connect();
    let order: { id: string; tenant_id: string; plan_id: string; mode: string; amount_minor: number; currency: string; status: string } | undefined;
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.actor',$1,true)", [user.userId]);
      const mem = await client.query('SELECT role FROM gymos.tenant_memberships WHERE tenant_id=$1 AND user_id=$2 AND NOT revoked', [body.tenantId, user.userId]);
      if (!mem.rows.length || mem.rows[0].role !== 'owner') {
        await client.query('ROLLBACK');
        return reply({ error: 'forbidden' }, 403);
      }
      const ord = await client.query('SELECT id,tenant_id,plan_id,mode,amount_minor,currency,status FROM gymos.activation_requests WHERE id=$1 AND tenant_id=$2', [body.orderId, body.tenantId]);
      order = ord.rows[0];
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    if (!order || order.status !== 'awaiting_payment' || !order.amount_minor || order.amount_minor <= 0) {
      return reply({ error: 'invalidOrder' }, 400);
    }

    const reference = `PLAT-${randomUUID().slice(0, 12).toUpperCase()}`;
    const intent: CheckoutIntent = {
      kind: 'platform_license',
      owner: order.tenant_id,
      tenantId: order.tenant_id,
      orderId: order.id,
      planId: order.plan_id,
      mode: order.mode,
      amountMinor: order.amount_minor,
      currency: order.currency || 'EGP',
      provider: 'paymob',
      reference,
      exp: Date.now() + 30 * 60 * 1000,
    };
    const token = signPaymentIntent(intent);

    // Strictly uses the PLATFORM owner's Paymob account configured in Vercel env vars
    const platformKeys =
      process.env.PAYMOB_SECRET_KEY && process.env.PAYMOB_PUBLIC_KEY && process.env.PAYMOB_INTEGRATION_ID
        ? {
            secretKey: process.env.PAYMOB_SECRET_KEY,
            publicKey: process.env.PAYMOB_PUBLIC_KEY,
            integrationId: process.env.PAYMOB_INTEGRATION_ID,
          }
        : null;

    const origin = new URL(request.url).origin;
    const checkout = await createGatewayCheckout({
      intent,
      token,
      buyerName: user.displayName || 'Gym Owner',
      buyerPhone: '+201000000000',
      buyerEmail: user.email,
      itemName: `GymEG License (${order.mode})`,
      notificationUrl: `${origin}/api/payments/webhook`,
      redirectionUrl: `${origin}/clubs`,
      paymobKeys: platformKeys,
    });

    return reply({
      ok: true,
      reference,
      amountMinor: order.amount_minor,
      currency: intent.currency,
      mode: checkout.mode,
      checkoutUrl: checkout.checkoutUrl,
    });
  } catch {
    return reply({ error: 'unavailable' }, 503);
  }
}
