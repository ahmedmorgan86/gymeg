import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export type PaymentProvider = 'paymob' | 'fawry' | 'instapay';

export type CheckoutIntent = {
  kind: 'member_subscription' | 'platform_license';
  owner: string;
  tenantId?: string;
  memberId?: string;
  branch?: string;
  planId: string;
  orderId?: string;
  mode?: string;
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

function aesKey(): Buffer {
  return createHash('sha256').update(intentSecret()).digest();
}

export function encryptGatewaySecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

export function decryptGatewaySecret(stored: string | undefined): string | null {
  if (!stored || typeof stored !== 'string') return null;
  const parts = stored.split('.');
  if (parts.length !== 3) return null;
  try {
    const iv = Buffer.from(parts[0], 'base64url');
    const tag = Buffer.from(parts[1], 'base64url');
    const data = Buffer.from(parts[2], 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', aesKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
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
  buyerName: string;
  buyerPhone: string;
  buyerEmail?: string;
  itemName: string;
  instapayAddress?: string;
  paymobKeys?: { secretKey: string; publicKey: string; integrationId: string } | null;
}): Promise<{ checkoutUrl: string | null; mode: 'live' | 'instapay' | 'pending_keys' }> {
  const { intent, token, buyerName, buyerPhone, buyerEmail, itemName, instapayAddress, paymobKeys } = params;

  if (intent.provider === 'paymob' && paymobKeys?.secretKey && paymobKeys?.publicKey && paymobKeys?.integrationId) {
    const [firstName, ...rest] = buyerName.trim().split(/\s+/);
    const res = await fetch('https://accept.paymob.com/v1/intention/', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${paymobKeys.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: intent.amountMinor,
        currency: intent.currency || 'EGP',
        payment_methods: [Number(paymobKeys.integrationId)],
        items: [{ name: itemName.slice(0, 50), amount: intent.amountMinor, quantity: 1 }],
        billing_data: {
          first_name: firstName || 'Customer',
          last_name: rest.join(' ') || 'GymEG',
          phone_number: buyerPhone || '+201000000000',
          email: buyerEmail || 'billing@gymeg.app',
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
          checkoutUrl: `https://accept.paymob.com/unifiedcheckout/?publicKey=${encodeURIComponent(paymobKeys.publicKey)}&clientSecret=${encodeURIComponent(data.client_secret)}`,
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
