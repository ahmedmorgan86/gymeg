'use client';
import { useState } from 'react';
import type { PaymentProvider } from '../lib/payment-gateway';

type PlanItem = { id: string; name: string; days: number; minor: number };

export default function MemberOnlineCheckout({
  plans,
  defaultProvider,
  instapayAddress,
  currency,
  clubId,
  ar,
  readOnly,
}: {
  plans: PlanItem[];
  defaultProvider: PaymentProvider;
  instapayAddress?: string;
  currency: string;
  clubId: string;
  ar: boolean;
  readOnly: boolean;
}) {
  const t = (a: string, b: string) => (ar ? a : b);
  const [planId, setPlanId] = useState(plans[0]?.id ?? '');
  const [provider, setProvider] = useState<PaymentProvider>(defaultProvider);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);

  if (!plans.length || readOnly) return null;
  const formatMoney = (minor: number) =>
    new Intl.NumberFormat(ar ? 'ar-EG' : 'en-GB', { style: 'currency', currency }).format(minor / 100);

  async function startCheckout() {
    if (!planId || busy) return;
    setBusy(true);
    setStatus('');
    setCheckoutUrl(null);
    try {
      const r = await fetch('/api/member-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId, provider, club: clubId }),
        signal: AbortSignal.timeout(15000),
      });
      const d = (await r.json()) as {
        ok?: boolean;
        reference?: string;
        checkoutUrl?: string | null;
        mode?: string;
        instapayAddress?: string | null;
        error?: string;
      };
      if (!r.ok || !d.ok) {
        setStatus(t('تعذر بدء الدفع الأونلاين حالياً.', 'Unable to start online checkout right now.'));
        return;
      }
      if (d.checkoutUrl) {
        setCheckoutUrl(d.checkoutUrl);
        setStatus(t(`تم تجهيز طلب الدفع (${d.reference}). اضغط لإتمام السداد.`, `Checkout ready (${d.reference}). Click below to complete payment.`));
      } else {
        setStatus(
          t(
            `تم إنشاء مرجع الدفع ${d.reference}. يرجى إتمام التحويل عبر ${provider.toUpperCase()} أو من الاستقبال.`,
            `Payment reference ${d.reference} created. Complete payment via ${provider.toUpperCase()} or reception.`
          )
        );
      }
    } catch {
      setStatus(t('تعذر الاتصال ببوابة الدفع.', 'Could not reach payment gateway.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" style={{ marginBottom: 14, padding: 14 }}>
      <h3 style={{ marginTop: 0 }}>{t('تجديد الاشتراك والدفع أونلاين', 'Renew & Pay Online')}</h3>
      <label>
        {t('اختر الباقة', 'Select plan')}
        <select value={planId} onChange={(e) => setPlanId(e.target.value)} disabled={busy}>
          {plans.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.days} {t('يوم', 'days')} · {formatMoney(p.minor)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t('وسيلة الدفع', 'Payment method')}
        <select value={provider} onChange={(e) => setProvider(e.target.value as PaymentProvider)} disabled={busy}>
          <option value="paymob">Paymob (Visa / Mastercard / Wallet)</option>
          <option value="fawry">Fawry Pay</option>
          <option value="instapay">InstaPay{instapayAddress ? ` (${instapayAddress})` : ''}</option>
        </select>
      </label>
      <button type="button" className="button primary" disabled={busy || !planId} onClick={() => void startCheckout()}>
        {busy ? t('جارٍ التجهيز…', 'Preparing…') : t('ادفع وجدد الآن', 'Pay & Renew Now')}
      </button>
      {status && <p role="status" style={{ marginTop: 8 }}>{status}</p>}
      {checkoutUrl && (
        <a className="button secondary" href={checkoutUrl} target="_blank" rel="noopener noreferrer" style={{ marginTop: 6, display: 'inline-flex' }}>
          {t('الانتقال لبوابة الدفع ←', 'Open Payment Gateway →')}
        </a>
      )}
    </section>
  );
}
