"use client";
import {useState, useEffect} from 'react';
import {useConfirmDialog} from '../components/ui/use-confirm-dialog';

type AccessProps = {member: string; owner: string; ar: boolean; busy: boolean; autoLoad?: boolean};

export default function MemberPortalAccess(props: AccessProps) {
  return <MemberPhoneAccess key={props.owner + ':' + props.member} {...props} />;
}

function MemberPhoneAccess({member, owner, ar, busy, autoLoad}: AccessProps) {
  const [credentials, setCredentials] = useState<{
    phone: string;
    pin: string | null;
    pinChanged?: boolean;
    changeRequired?: boolean;
  } | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [revoked, setRevoked] = useState(false);
  const [customPin, setCustomPin] = useState('');
  const [showCustomPin, setShowCustomPin] = useState(false);

  const t = (a: string, e: string) => (ar ? a : e);
  const {confirm, dialog} = useConfirmDialog();

  useEffect(() => {
    if (autoLoad) {
      void action('read');
    }
  }, [autoLoad]);

  async function action(act: 'read' | 'rotate' | 'revoke' | 'requireChange' | 'setPin', pinValue?: string) {
    setPending(true);
    setMessage('');
    try {
      const r = await fetch('/api/member-code', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-GymOS-Tenant': owner},
        body: JSON.stringify({member, action: act, pin: pinValue}),
        signal: AbortSignal.timeout(10000)
      });
      const d = await r.json();
      if (!r.ok) {
        if (d.error === 'invalidPin') throw Error('invalidPin');
        throw Error(d?.error || 'requestFailed');
      }

      setCredentials({
        phone: d.phone ?? credentials?.phone ?? '',
        pin: d.pin ?? null,
        pinChanged: Boolean(d.pinChanged),
        changeRequired: Boolean(d.changeRequired)
      });
      setRevoked(Boolean(d.revoked));
      setShowCustomPin(false);
      setCustomPin('');

      if (d.revoked) {
        setMessage(t('دخول العضو موقوف. أعد تعيين الرقم لتفعيل الدخول.', 'Member access is disabled. Reset the PIN to enable access.'));
      } else if (act === 'setPin') {
        setMessage(t('تم تعيين كلمة المرور المؤقتة بنجاح، وستكون قابلة للتغيير عند أول دخول.', 'Custom temporary PIN assigned successfully; member must change it on first sign-in.'));
      } else if (act === 'rotate') {
        setMessage(t('تم إصدار كلمة مرور مؤقتة جديدة بنجاح؛ يلزم تغييرها عند أول دخول.', 'A new temporary PIN has been issued; member must change it on first sign-in.'));
      } else if (act === 'requireChange') {
        setMessage(t('تم إلزام العضو بتغيير رقمه عند دخوله التالي.', 'Member will be required to change the PIN upon next sign-in.'));
      } else if (act === 'revoke') {
        setMessage(t('تم إيقاف الدخول بنجاح.', 'Access disabled successfully.'));
      } else if (d.pinChanged) {
        setMessage(t('العضو غيّر الرقم السري، وهو مأمّن وخاص به. يمكنك إصدار رقم مؤقت جديد عند الحاجة.', 'The member changed their PIN; it is private. You can issue a new temporary PIN if needed.'));
      } else if (d.needsPhone) {
        setMessage(t('أضف رقم موبايل صحيحًا في بيانات العضو أولًا.', 'Please save a valid mobile number for this member first.'));
      }
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      const isInvalidPin = err instanceof Error && err.message === 'invalidPin';
      if (isInvalidPin) {
        setMessage(t('الرقم السري يجب أن يتكون من 6 أرقام وغير متوقع (تجنب 123456 أو أرقام مكررة).', 'PIN must be 6 non-repeating digits and not a predictable sequence.'));
      } else if (isTimeout) {
        setMessage(t('انتهت مهلة الاتصال بالخادم. تحقق من الإنترنت وأعد المحاولة.', 'Server request timed out. Check connection and retry.'));
      } else {
        setMessage(t('تعذر تحديث بيانات الدخول. تحقق من الاتصال والصلاحية.', 'Cannot update sign-in details. Check connection and permission.'));
      }
    } finally {
      setPending(false);
    }
  }

  const shareWhatsApp = () => {
    if (!credentials?.phone || !credentials?.pin) return;
    const cleanPhone = credentials.phone.replace(/[^0-9]/g, '');
    const origin = typeof window !== 'undefined' ? window.location.origin : 'https://gymeg.vercel.app';
    const text = `${t('أهلاً بك في نادينا! 🎉', 'Welcome to the club! 🎉')}\n\n${t('بيانات دخولك لتطبيق الأعضاء:', 'Your sign-in details:')}\n🔗 ${origin}/member\n📱 ${t('رقم الدخول (الموبايل):', 'Mobile:')} ${credentials.phone}\n🔑 ${t('كلمة المرور المؤقتة:', 'Temporary PIN:')} ${credentials.pin}\n\n🔒 ${t('ملاحظة: سيُطلب منك تغيير الرقم السري فور تسجيل الدخول لضمان خصوصيتك وأمان حسابك.', 'Note: You will be asked to change this temporary PIN upon first sign-in for your security.')}`;
    window.open(`https://wa.me/${cleanPhone}?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer');
  };

  const copyCredentials = async () => {
    if (!credentials?.phone) return;
    const origin = typeof window !== 'undefined' ? window.location.origin : 'https://gymeg.vercel.app';
    const pinPart = credentials.pin ? `\n${t('الرقم السري المؤقت:', 'Temporary PIN:')} ${credentials.pin}` : '';
    const fullText = `${t('تطبيق الأعضاء:', 'Member App:')} ${origin}/member\n${t('الموبايل:', 'Mobile:')} ${credentials.phone}${pinPart}`;
    try {
      await navigator.clipboard.writeText(fullText);
      setMessage(t('تم نسخ بيانات الدخول بنجاح.', 'Sign-in details copied successfully.'));
    } catch {
      setMessage(t('حدد البيانات وانسخها يدويًا.', 'Select and copy the details manually.'));
    }
  };

  const btnSecondaryStyle: React.CSSProperties = {
    background: 'var(--surface-soft, #22222f)',
    color: 'var(--text, #f0edf9)',
    border: '1px solid var(--line, #38384a)',
    padding: '8px 14px',
    borderRadius: 8,
    fontWeight: 600,
    fontSize: 13,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    cursor: 'pointer'
  };

  return (
    <section className="card member-access-panel" style={{display: 'grid', gap: 14, border: '1px solid var(--line)', padding: 16, borderRadius: 12}}>
      <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
          <h3 style={{margin: 0, fontSize: 16, fontWeight: 800}}>
            📱 {t('تطبيق الموبايل — الدخول وكلمة المرور', 'Member App — Sign-in & PIN')}
          </h3>
          {pending && <small style={{color: 'var(--muted)', fontSize: 12}}>({t('جارٍ التحميل...', 'Loading...')})</small>}
        </div>

        {credentials?.pin && !credentials.pinChanged && (
          <span style={{background: '#10b98124', color: '#10b981', border: '1px solid #10b98144', padding: '4px 10px', borderRadius: 20, fontSize: 12, fontWeight: 700}}>
            🔒 {t('كلمة مرور مؤقتة قابلة للتغيير', 'Changeable Temporary PIN')}
          </span>
        )}
        {credentials?.pinChanged && (
          <span style={{background: '#8b5cf624', color: '#a78bfa', border: '1px solid #8b5cf644', padding: '4px 10px', borderRadius: 20, fontSize: 12, fontWeight: 700}}>
            🛡️ {t('الرقم السري مأمّن ومغيّر بواسطة العضو', 'PIN Changed & Secured by Member')}
          </span>
        )}
      </div>

      <p style={{margin: 0, fontSize: 13, color: 'var(--muted)', lineHeight: 1.6}}>
        {t(
          'يتم ربط العضو تلقائيًا برقم موبايله المسجل ورقم سري مؤقت من 6 أرقام. يلزم العضو تغييره إلى رقم سري خاص به عند تسجيل الدخول الأول لحماية خصوصيته.',
          'Members sign in using their registered mobile and a temporary 6-digit PIN. The member must change it on first sign-in to protect privacy.'
        )}
      </p>

      {message && (
        <p role="status" style={{fontWeight: 700, margin: 0, padding: '8px 12px', borderRadius: 8, background: 'var(--purple-soft, #7c3aed18)', fontSize: 13, color: 'var(--pt-electric, #a855f7)'}}>
          ℹ️ {message}
        </p>
      )}

      {revoked && (
        <div style={{background: '#ef44441a', border: '1px solid #ef444440', padding: '10px 14px', borderRadius: 8, color: '#ef4444', fontSize: 13, fontWeight: 700}}>
          ⚠️ {t('دخول هذا العضو لتطبيق الموبايل موقوف حاليًا. أعد تعيين رقم سري لتفعيل الدخول مجددًا.', 'Mobile access for this member is currently disabled. Reset PIN to re-enable.')}
        </div>
      )}

      {!credentials && (
        <div style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, padding: '14px 18px', background: 'var(--surface-soft, #22222f)', border: '1px solid var(--line, #38384a)', borderRadius: 10}}>
          <div>
            <b style={{fontSize: 14, color: 'var(--text, #f0edf9)', display: 'block'}}>
              📱 {t('بيانات الدخول لتطبيق الموبايل', 'Member app sign-in credentials')}
            </b>
            <span style={{fontSize: 12, color: 'var(--muted, #9a96ae)'}}>
              {t('انقر لعرض رقم الموبايل المسجل وكلمة المرور المؤقتة ومشاركتها عبر واتساب.', 'Click to view registered mobile, temporary PIN, and share via WhatsApp.')}
            </span>
          </div>
          <button
            type="button"
            className="button primary"
            style={{
              color: '#ffffff',
              background: 'linear-gradient(105deg, #7c3aed, #9333ea)',
              border: 'none',
              padding: '10px 20px',
              borderRadius: 8,
              fontWeight: 700,
              fontSize: 14,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              cursor: 'pointer',
              boxShadow: '0 4px 12px rgba(124, 58, 237, 0.35)'
            }}
            disabled={busy || pending}
            onClick={() => void action('read')}
          >
            👁️ {pending ? t('جارٍ التحميل...', 'Loading...') : t('عرض بيانات دخول العضو', 'Show Member Sign-in Details')}
          </button>
        </div>
      )}

      {credentials && (
        <div className="member-invitation" style={{background: 'var(--surface-soft, #1e1e2d)', border: '1px solid var(--line, #38384a)', padding: 16, borderRadius: 10, display: 'grid', gap: 12}}>
          <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12}}>
            <label style={{display: 'grid', gap: 6, fontSize: 13, fontWeight: 600}}>
              <span>{t('رقم الموبايل (اسم المستخدم للولوج)', 'Mobile number (Sign-in username)')}</span>
              <input
                dir="ltr"
                readOnly
                value={credentials.phone || t('غير مسجل', 'Not recorded')}
                style={{fontWeight: 700, fontSize: 16, background: 'var(--surface)', border: '1px solid var(--line)'}}
              />
            </label>

            <label style={{display: 'grid', gap: 6, fontSize: 13, fontWeight: 600}}>
              <span>
                {credentials.pinChanged
                  ? t('حالة الرقم السري', 'PIN Status')
                  : t('كلمة المرور المؤقتة الحالية', 'Current Temporary PIN')}
              </span>
              <input
                dir="ltr"
                readOnly
                value={
                  credentials.pin
                    ? credentials.pin
                    : credentials.pinChanged
                    ? t('🛡️ رقم خاص بالعضو (مشفر ومحمي)', '🛡️ Private member PIN (secured)')
                    : t('غير متوفر', 'Unavailable')
                }
                style={{
                  fontWeight: 800,
                  fontSize: 18,
                  letterSpacing: credentials.pin ? 4 : 0,
                  color: credentials.pin ? 'var(--text)' : 'var(--muted)',
                  background: 'var(--surface)',
                  border: '1px solid var(--line)'
                }}
                onFocus={e => e.currentTarget.select()}
              />
            </label>
          </div>

          <div style={{display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4}}>
            {credentials.pin && !credentials.pinChanged && (
              <button
                type="button"
                className="button primary"
                style={{color: '#ffffff', background: '#25D366', border: 'none', fontWeight: 700, padding: '9px 16px', borderRadius: 8, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer'}}
                onClick={shareWhatsApp}
              >
                💬 {t('إرسال عبر واتساب', 'Send via WhatsApp')}
              </button>
            )}

            <button
              type="button"
              className="button secondary"
              style={btnSecondaryStyle}
              onClick={copyCredentials}
            >
              📋 {t('نسخ بيانات الدخول', 'Copy details')}
            </button>

            <button
              type="button"
              className="button secondary"
              style={btnSecondaryStyle}
              onClick={() => setShowCustomPin(v => !v)}
            >
              ✏️ {showCustomPin ? t('إلغاء التخصيص', 'Cancel custom') : t('تخصيص رقم سري محدد', 'Set custom PIN')}
            </button>

            <a
              className="button secondary"
              style={{...btnSecondaryStyle, textDecoration: 'none'}}
              href={'/member?member=' + encodeURIComponent(member) + '&club=' + encodeURIComponent(owner)}
              target="_blank"
              rel="noopener noreferrer"
            >
              📱 {t('معاينة تطبيق العضو', 'Preview Member App')}
            </a>
          </div>

          {showCustomPin && (
            <div style={{display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 8, padding: 12, background: 'var(--surface)', borderRadius: 8, border: '1px solid var(--line)'}}>
              <label style={{display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700}}>
                <span>{t('أدخل 6 أرقام للرقم المؤقت:', 'Enter 6 digits:')}</span>
                <input
                  dir="ltr"
                  inputMode="numeric"
                  maxLength={6}
                  pattern="[0-9]{6}"
                  placeholder="123456"
                  value={customPin}
                  onChange={e => setCustomPin(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
                  style={{width: 140, fontWeight: 800, fontSize: 16, letterSpacing: 3, textAlign: 'center'}}
                />
              </label>
              <button
                type="button"
                className="button primary"
                style={{color: '#ffffff', background: 'linear-gradient(105deg,#7c3aed,#9333ea)', border: 'none', padding: '8px 16px', borderRadius: 8, fontWeight: 700, cursor: 'pointer'}}
                disabled={busy || pending || customPin.length !== 6}
                onClick={() => void action('setPin', customPin)}
              >
                💾 {t('حفظ كرقم مؤقت للعضو', 'Save as temporary PIN')}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="head-actions" style={{display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 4}}>
        <button
          type="button"
          className="button secondary"
          style={btnSecondaryStyle}
          disabled={busy || pending}
          onClick={async () => {
            if (await confirm({
              title: t('إعادة تعيين الرقم السري؟', 'Reset the PIN?'),
              description: t('سيتم إصدار رقم سري مؤقت جديد مكون من 6 أرقام للعضو، مع إلزامه بتغييره عند تسجيل الدخول، وإنهاء أي جلسات سابقة.', 'A new temporary 6-digit PIN will be issued for the member, requiring a change at sign-in, and terminating active sessions.')
            })) {
              void action('rotate');
            }
          }}
        >
          🔄 {t('إعادة تعيين رقم سري عشوائي', 'Reset Random PIN')}
        </button>

        <button
          type="button"
          className="button secondary"
          style={btnSecondaryStyle}
          disabled={busy || pending || revoked}
          onClick={async () => {
            if (await confirm({
              title: t('إلزام العضو بتغيير رقمه السري؟', 'Require a PIN change?'),
              description: t('سيُطلب من العضو تغيير رقمه السري عند دخوله التالي برقمه الحالي، مع إنهاء جلساته النشطة الحالية دون كشف رقمه.', 'The member must change their PIN at next sign-in and active sessions will end, without revealing the PIN.')
            })) {
              void action('requireChange');
            }
          }}
        >
          🔒 {t('إلزام التغيير عند الدخول القادم', 'Require PIN change at next sign-in')}
        </button>

        <button
          type="button"
          className="text-button"
          style={{
            ...btnSecondaryStyle,
            background: 'transparent',
            borderColor: revoked ? '#10b981' : '#ef4444',
            color: revoked ? '#10b981' : '#ef4444'
          }}
          disabled={busy || pending}
          onClick={async () => {
            if (await confirm({
              title: revoked ? t('تفعيل دخول العضو؟', 'Enable member access?') : t('إيقاف دخول هذا العضو؟', 'Disable this member’s access?'),
              description: revoked
                ? t('سيتم إعادة تفعيل إمكانية تسجيل الدخول وإصدار رقم سري جديد.', 'Sign-in will be re-enabled and a new PIN issued.')
                : t('لن يتمكن هذا العضو من تسجيل الدخول لتطبيق الموبايل حتى يتم تفعيله مجددًا.', 'The member will not be able to sign in to the mobile app until re-enabled.')
            })) {
              if (revoked) void action('rotate');
              else void action('revoke');
            }
          }}
        >
          {revoked ? '✅ ' + t('إعادة تفعيل الدخول', 'Enable access') : '🚫 ' + t('إيقاف الدخول', 'Disable access')}
        </button>

        <button
          type="button"
          className="button secondary"
          style={btnSecondaryStyle}
          disabled={busy || pending}
          onClick={() => void action('read')}
        >
          🔄 {t('تحديث البيانات', 'Refresh')}
        </button>
      </div>

      {dialog}
    </section>
  );
}
