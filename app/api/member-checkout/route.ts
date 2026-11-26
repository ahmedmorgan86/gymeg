import { randomUUID } from 'node:crypto';
import { getChatGPTUser } from '../../chatgpt-auth';
import { getPool } from '../../lib/database';
import { isFirestorePersistence, getFirestoreDb } from '../../lib/firestore-db';
import { memberSessionToken } from '../../lib/member-code';
import { codeMemberIdentity } from '../../lib/member-code-session';
import { createGatewayCheckout, signPaymentIntent, type PaymentProvider } from '../../lib/payment-gateway';
import { readMemberSpace, reply, sameOrigin } from '../../lib/server-workspace';

export async function POST(request: Request) {
  try {
    if (!sameOrigin(request)) return reply({ error: 'origin' }, 403);
    const raw = await request.text();
    if (raw.length > 2048) return reply({ error: 'limit' }, 413);
    const body = JSON.parse(raw) as { planId?: unknown; provider?: unknown; club?: unknown };
    if (typeof body.planId !== 'string' || !body.planId) return reply({ error: 'invalid' }, 400);

    let owner = '';
    let memberId = '';
    let branch = '';

    const codeToken = memberSessionToken(request);
    const codeIdentity = codeToken ? await codeMemberIdentity(request) : null;
    if (codeIdentity) {
      if (codeIdentity.pin_must_change) return reply({ error: 'pinChangeRequired' }, 403);
      owner = codeIdentity.owner_id;
      memberId = codeIdentity.member_id;
      branch = codeIdentity.branch;
    } else {
      const user = await getChatGPTUser();
      if (!user) return reply({ error: 'auth' }, 401);
      if (isFirestorePersistence()) {
        const snap = await getFirestoreDb().collection('member_portal_access').where('user_id', '==', user.userId).get();
        const links = snap.docs.map((d) => d.data() as { owner_id: string; member_id: string; branch: string; revoked: boolean }).filter((l) => !l.revoked);
        const picked = typeof body.club === 'string' ? links.find((l) => l.owner_id === body.club) : links[0];
        if (!picked) return reply({ error: 'notLinked' }, 404);
        owner = picked.owner_id;
        memberId = picked.member_id;
        branch = picked.branch;
      } else {
        const client = await getPool().connect();
        try {
          await client.query('BEGIN');
          await client.query("SELECT set_config('app.actor',$1,true)", [user.userId]);
          const rows = (await client.query('SELECT owner_id,member_id,branch FROM gymos.member_portal_access WHERE user_id=$1 AND NOT revoked', [user.userId])).rows as { owner_id: string; member_id: string; branch: string }[];
          await client.query('COMMIT');
          const picked = typeof body.club === 'string' ? rows.find((l) => l.owner_id === body.club) : rows[0];
          if (!picked) return reply({ error: 'notLinked' }, 404);
          owner = picked.owner_id;
          memberId = picked.member_id;
          branch = picked.branch;
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      }
    }

    const { state } = await readMemberSpace(owner, memberId, branch, new Date().toISOString());
    const member = state.members.find((m) => m.id === memberId && m.branch === branch && !m.archived && !m.demo);
    if (!member) return reply({ error: 'notLinked' }, 404);

    const gw = state.settings.paymentGateway;
    if (!gw?.enabled) return reply({ error: 'gatewayDisabled' }, 403);

    const plan = (state.plans ?? []).find((p) => p.id === body.planId && p.branch === branch && !p.archived);
    if (!plan || plan.minor <= 0) return reply({ error: 'invalid' }, 400);

    const provider: PaymentProvider =
      body.provider === 'fawry' || body.provider === 'instapay' || body.provider === 'paymob'
        ? body.provider
        : gw.provider;

    const reference = `GYM-${randomUUID().slice(0, 12).toUpperCase()}`;
    const intent = {
      owner,
      memberId,
      branch,
      planId: plan.id,
      amountMinor: plan.minor,
      currency: state.settings.currency || 'EGP',
      provider,
      reference,
      exp: Date.now() + 30 * 60 * 1000,
    };
    const token = signPaymentIntent(intent);
    const origin = new URL(request.url).origin;
    const checkout = await createGatewayCheckout({
      intent,
      token,
      memberName: member.name,
      memberPhone: member.phone,
      planName: plan.name,
      instapayAddress: gw.instapayAddress,
      origin,
    });

    return reply({
      ok: true,
      reference,
      provider,
      amountMinor: plan.minor,
      currency: intent.currency,
      mode: checkout.mode,
      checkoutUrl: checkout.checkoutUrl,
      instapayAddress: gw.instapayAddress ?? null,
    });
  } catch {
    return reply({ error: 'unavailable' }, 503);
  }
}
