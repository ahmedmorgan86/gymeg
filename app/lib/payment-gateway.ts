import { createHmac, timingSafeEqual } from 'node:crypto';

export type PaymentProvider = 'paymob' | 'fawry' | 'instapay';

export type CheckoutIntent = {
  owner: string;
  memberId: string;
  branch: string;
  planId: string;
  amountMinor: number;
  currency: string;
  provider: PaymentProvider;
  reference: string;
  exp: number;
};

function intentSecret(): string {
  const secret = process.env.PAYMENT_INTENT_SECRET || process.env.SESSION_SECRET || process.env.AUTH_SECRET || process.env.CRON_SECRET;
  if (!secret) throw new Error('paymentSecretMissing');
  return secret;
}

export function signPaymentIntent(intent: CheckoutIntent): string {
  const payload = Buffer.from(JSON.stringify(intent), 'utf8').toString('base64url');
  const sig = createHmac('sha256', intentSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyPaymentIntent(token: string): CheckoutIntent | null {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  try {
    const expected = createHmac('sha256', intentSecret()).update(payload).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as CheckoutIntent;
    if (!decoded || typeof decoded.exp !== 'number' || decoded.exp < Date.now()) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function verifyWebhookSignature(rawBody: string, headerSig: string | null, secretEnv: string | undefined): boolean {
  if (!headerSig || !secretEnv) return false;
  try {
    const expected = createHmac('sha256', secretEnv).update(rawBody).digest('hex');
    const a = Buffer.from(headerSig.toLowerCase());
    const b = Buffer.from(expected.toLowerCase());
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function createGatewayCheckout(params: {
  intent: CheckoutIntent;
  token: string;
  memberName: string;
  memberPhone: string;
  planName: string;
  instapayAddress?: string;
  origin: string;
}): Promise<{ checkoutUrl: string | null; mode: 'live' | 'instapay' | 'pending_keys' }> {
  const { intent, token, memberName, memberPhone, planName, instapayAddress } = params;

  if (intent.provider === 'paymob' && process.env.PAYMOB_SECRET_KEY && process.env.PAYMOB_PUBLIC_KEY && process.env.PAYMOB_INTEGRATION_ID) {
    const [firstName, ...rest] = memberName.trim().split(/\s+/);
    const res = await fetch('https://accept.paymob.com/v1/intention/', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${process.env.PAYMOB_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: intent.amountMinor,
        currency: intent.currency || 'EGP',
        payment_methods: [Number(process.env.PAYMOB_INTEGRATION_ID)],
        items: [{ name: planName.slice(0, 50), amount: intent.amountMinor, quantity: 1 }],
        billing_data: {
          first_name: firstName || 'Member',
          last_name: rest.join(' ') || 'GymEG',
          phone_number: memberPhone || '+201000000000',
          email: 'member@gymeg.app',
        },
        special_reference: intent.reference,
        extras: { gymeg_intent: token },
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = (await res.json()) as { client_secret?: string };
      if (data.client_secret) {
        return {
          mode: 'live',
          checkoutUrl: `https://accept.paymob.com/unifiedcheckout/?publicKey=${encodeURIComponent(process.env.PAYMOB_PUBLIC_KEY)}&clientSecret=${encodeURIComponent(data.client_secret)}`,
        };
      }
    }
  }

  if (intent.provider === 'instapay' && instapayAddress) {
    return {
      mode: 'instapay',
      checkoutUrl: `https://ipn.eg/S/${encodeURIComponent(instapayAddress)}`,
    };
  }

  return { mode: 'pending_keys', checkoutUrl: null };
}
