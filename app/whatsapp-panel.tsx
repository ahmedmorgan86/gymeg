"use client";
import ManualWhatsApp from './manual-whatsapp';
import { useEffect, useEffectEvent, useState } from 'react';
import type { GymState, Operation } from './lib/domain';
import { type WhatsAppRule } from './lib/whatsapp';
import { useConfirmDialog } from '../components/ui/use-confirm-dialog';

const kinds = {
  welcome: ['ترحيب بالأعضاء الجدد', 'Welcome new members'],
  policy: ['ملف سياسات النادي للعضو الجديد', 'Club policy for new members'],
  birthday: ['عيد الميلاد', 'Birthday'],
  occasion: ['مناسبة بتاريخ محدد', 'Dated occasion'],
  absence: ['غياب عن الحضور', 'Attendance gap'],
  renewal: ['قبل انتهاء العضوية', 'Before membership expiry'],
  expired: ['انتهاء العضوية', 'Expired membership'],
} as const;

type WppConn = {
  provider: 'meta' | 'wppconnect' | 'manual';
  status: 'DISCONNECTED' | 'STARTING' | 'WAITING_FOR_QR' | 'QR_EXPIRED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'FAILED';
  connected_phone: string | null;
  qr_data_url: string | null;
  qr_expires_at: string | null;
  last_connected_at: string | null;
  last_error: string | null;
  daily_limit: number;
  sent_today: number;
};

type InboxItem = {
  id: string;
  member_id: string | null;
  display_phone: string;
  contact_name: string;
  assigned_to: string | null;
  status: string;
  unread_count: number;
  last_message_at: string;
};

type InboxMsg = {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string;
  status: string;
  created_at: string;
};

type AutoReplyRow = {
  id: string;
  enabled: boolean;
  name: string;
  keywords: string[];
  reply_text: string;
  welcome_text: string;
  off_hours_text: string;
  start_hour: number;
  end_hour: number;
  handoff_to_staff: boolean;
  cooldown_minutes: number;
};

type Data = {
  connection: { phone_id: string; api_version: string } | null;
  encryptionReady: boolean;
  wppSupported?: boolean;
  wppConnection?: WppConn | null;
  rules: WhatsAppRule[];
  outbox: { id: string; member_id: string; status: string; error: string; updated_at: string }[];
  inbox?: InboxItem[];
  autoReplies?: AutoReplyRow[];
};

type Tab = 'connection' | 'inbox' | 'notifications' | 'autoreplies' | 'logs' | 'settings';

function AutomaticWhatsAppPanel({
  state,
  owner,
  branch,
  ar,
  role,
  mutate,
}: {
  state: GymState;
  owner: string;
  branch: string;
  ar: boolean;
  role: string;
  mutate: (op: Omit<Operation, 'branch'> & { type: string }) => Promise<boolean>;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>('connection');
  const [edit, setEdit] = useState<WhatsAppRule | null>(null);
  const [inboxSearch, setInboxSearch] = useState('');
  const [selectedInbox, setSelectedInbox] = useState<InboxItem | null>(null);
  const [messages, setMessages] = useState<InboxMsg[]>([]);
  const [replyText, setReplyText] = useState('');
  const t = (a: string, e: string) => (ar ? a : e);
  const { confirm, dialog } = useConfirmDialog();
  const url = '/api/whatsapp?branch=' + encodeURIComponent(branch);
  const headers = { 'Content-Type': 'application/json', 'X-GymOS-Tenant': owner };

  async function load() {
    const r = await fetch(url, { headers, cache: 'no-store' });
    if (!r.ok) throw Error();
    setData(await r.json());
  }

  const refresh = useEffectEvent(() => {
    void load().catch(() => setMessage(t('تعذر تحميل إعدادات واتساب', 'Could not load WhatsApp settings')));
  });

  useEffect(() => {
    const init = setTimeout(() => refresh(), 0);
    return () => clearTimeout(init);
  }, [owner, branch]);

  // Auto-poll status/QR while WPPConnect is handshaking
  const wppStatus = data?.wppConnection?.status;
  useEffect(() => {
    if (!wppStatus || !['STARTING', 'WAITING_FOR_QR', 'CONNECTING', 'RECONNECTING'].includes(wppStatus)) return;
    const id = setInterval(() => refresh(), 3000);
    return () => clearInterval(id);
  }, [wppStatus]);

  async function send(body: unknown) {
    setBusy(true);
    try {
      const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) {
        throw Error(
          d.error === 'integrationKeyMissing'
            ? t('مفتاح تشفير التكامل غير مهيأ على الخادم.', 'Server integration encryption key missing.')
            : d.error === 'postgresRequiredForWppConnect'
              ? t('يتطلب WPPConnect قاعدة بيانات PostgreSQL.', 'WPPConnect requires PostgreSQL backend.')
              : t('تعذر تنفيذ الطلب؛ راجع الحقول وحالة الاتصال.', 'Request failed; check fields and connection.')
        );
      }
      setMessage(t('تم تنفيذ الطلب', 'Request completed'));
      await load();
      return d;
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Error');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function openConversation(conv: InboxItem) {
    setSelectedInbox(conv);
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ action: 'inbox.messages', inboxId: conv.id }) });
    if (res.ok) {
      const d = (await res.json()) as { messages?: InboxMsg[] };
      setMessages(d.messages ?? []);
    }
  }

  if (!['owner', 'manager'].includes(role)) return <p>{t('للمالك والمدير فقط', 'Owners and managers only')}</p>;

  const activeProvider = data?.wppConnection?.provider ?? 'meta';
  const wpp = data?.wppConnection;
  const filteredInbox = (data?.inbox ?? []).filter((c) => {
    const q = inboxSearch.trim().toLowerCase();
    if (!q) return true;
    return c.display_phone.toLowerCase().includes(q) || c.contact_name.toLowerCase().includes(q);
  });

  const tabs: [Tab, string][] = [
    ['connection', t('الاتصال', 'Connection')],
    ['inbox', t('المحادثات', 'Inbox')],
    ['notifications', t('الإشعارات', 'Notifications')],
    ['autoreplies', t('الردود التلقائية', 'Auto-replies')],
    ['logs', t('سجل الرسائل', 'Message log')],
    ['settings', t('الإعدادات', 'Settings')],
  ];

  return (
    <section className="feature-panel">
      <h1>{t('واتساب النادي', 'Club WhatsApp')}</h1>
      {message && <p role="status" className="operation-notice">{message}</p>}

      <nav className="tabs standalone" aria-label={t('أقسام واتساب', 'WhatsApp sections')}>
        {tabs.map(([id, label]) => (
          <button key={id} type="button" className={tab === id ? 'selected' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>

      {tab === 'connection' && (
        <>
          {activeProvider === 'wppconnect' && (
            <section className="card">
              <h2>{t('ربط واتساب عبر QR Code (WPPConnect)', 'Connect WhatsApp via QR Code (WPPConnect)')}</h2>
              <p>
                {t('الحالة الحالية:', 'Status:')}{' '}
                <b>{wpp?.status ?? 'DISCONNECTED'}</b>
                {wpp?.connected_phone && <> · <bdi>{wpp.connected_phone}</bdi></>}
              </p>
              {wpp?.last_connected_at && (
                <p className="small muted">{t('آخر اتصال:', 'Last connected:')} {wpp.last_connected_at}</p>
              )}
              {wpp?.last_error && (
                <p role="alert" className="operation-notice">{t('آخر خطأ:', 'Last error:')} {wpp.last_error}</p>
              )}
              {wpp?.status === 'WAITING_FOR_QR' && wpp.qr_data_url && (
                <div style={{ margin: '12px 0' }}>
                  <p>{t('امسح رمز QR من تطبيق واتساب على هاتفك (الأجهزة المرتبطة):', 'Scan this QR code from WhatsApp → Linked Devices:')}</p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={wpp.qr_data_url} alt="WhatsApp QR" style={{ width: 220, height: 220, borderRadius: 12, border: '1px solid var(--line)' }} />
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                <button type="button" className="button primary" disabled={busy} onClick={() => void send({ action: 'wpp.connect' })}>
                  {wpp?.status === 'CONNECTED' ? t('إعادة الربط', 'Reconnect') : t('ربط رقم واتساب', 'Connect WhatsApp number')}
                </button>
                <button type="button" className="button secondary" disabled={busy || wpp?.status === 'DISCONNECTED'} onClick={() => void send({ action: 'wpp.disconnect' })}>
                  {t('فصل الجلسة', 'Disconnect session')}
                </button>
              </div>
              {wpp?.status === 'CONNECTED' && (
                <form
                  style={{ marginTop: 14 }}
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const f = new FormData(e.currentTarget);
                    if (await send({ action: 'wpp.test', phone: f.get('phone'), text: f.get('text') })) e.currentTarget.reset();
                  }}
                >
                  <h3>{t('إرسال رسالة اختبار', 'Send test message')}</h3>
                  <label>{t('رقم الهاتف (مع رمز الدولة)', 'Phone (+country code)')}<input name="phone" dir="ltr" placeholder="+2010..." required /></label>
                  <label>{t('نص الرسالة', 'Message')}<input name="text" maxLength={500} required /></label>
                  <button className="button secondary" disabled={busy}>{t('إرسال اختبار', 'Send test')}</button>
                </form>
              )}
            </section>
          )}

          {activeProvider === 'meta' && (
            <section className="card">
              <h2>{t('ربط رقم الفرع (Meta Cloud API)', 'Connect branch sender (Meta Cloud API)')}</h2>
              <p>{data?.connection ? t('متصل بمعرّف رقم: ', 'Connected phone ID: ') + data.connection.phone_id : t('غير متصل', 'Not connected')}</p>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  const form = e.currentTarget;
                  const f = new FormData(form);
                  if (await send({ action: 'connect', phoneId: f.get('phoneId'), apiVersion: f.get('apiVersion'), token: f.get('token') })) form.reset();
                }}
              >
                <label>Phone number ID<input name="phoneId" pattern="[0-9]{5,30}" defaultValue={data?.connection?.phone_id} required /></label>
                <label>Graph API version<input name="apiVersion" placeholder="vXX.0" pattern="v[0-9]{2}\.0" defaultValue={data?.connection?.api_version} required /></label>
                <label>{t('رمز الوصول — يُخزن مشفرًا ولا يُعاد عرضه', 'Access token — encrypted')}<input name="token" type="password" autoComplete="off" required minLength={20} /></label>
                <button className="button primary" disabled={busy || !data?.encryptionReady}>{t('حفظ الربط', 'Save connection')}</button>
              </form>
              <button className="text-button" disabled={busy || !data?.connection} onClick={async () => { if (await confirm({ title: t('فصل الرقم وإلغاء الرسائل المعلقة؟', 'Disconnect sender and cancel pending messages?') })) void send({ action: 'disconnect' }); }}>
                {t('فصل الرقم', 'Disconnect sender')}
              </button>
            </section>
          )}
        </>
      )}

      {tab === 'inbox' && (
        <section className="card">
          <h2>{t('صندوق المحادثات', 'Club Inbox')}</h2>
          <input type="search" value={inboxSearch} onChange={(e) => setInboxSearch(e.target.value)} placeholder={t('بحث بالاسم أو الهاتف...', 'Search name or phone...')} />
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1fr) 2fr', gap: 12, marginTop: 12 }}>
            <div>
              {!filteredInbox.length && <p className="muted">{t('لا توجد محادثات بعد.', 'No conversations yet.')}</p>}
              {filteredInbox.map((c) => (
                <button key={c.id} type="button" className={selectedInbox?.id === c.id ? 'button primary' : 'button secondary'} style={{ width: '100%', justifyContent: 'space-between', marginBottom: 6 }} onClick={() => void openConversation(c)}>
                  <span>{c.contact_name || c.display_phone}</span>
                  {c.unread_count > 0 && <small>({c.unread_count})</small>}
                </button>
              ))}
            </div>
            <div>
              {selectedInbox ? (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <b>{selectedInbox.contact_name || selectedInbox.display_phone}</b>
                    {selectedInbox.member_id && <small>{t('مربوط بملف عضو', 'Linked member')}</small>}
                  </div>
                  <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 10, padding: 10, marginBottom: 8 }}>
                    {messages.map((m) => (
                      <p key={m.id} style={{ textAlign: m.direction === 'outbound' ? 'end' : 'start', margin: '6px 0' }}>
                        <span>{m.body}</span>
                        <br />
                        <small className="muted">{m.status}</small>
                      </p>
                    ))}
                  </div>
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (!replyText.trim()) return;
                      if (await send({ action: 'inbox.reply', inboxId: selectedInbox.id, text: replyText })) {
                        setReplyText('');
                        await openConversation(selectedInbox);
                      }
                    }}
                  >
                    <input value={replyText} onChange={(e) => setReplyText(e.target.value)} maxLength={2000} placeholder={t('اكتب رداً...', 'Write a reply...')} />
                    <button className="button primary" disabled={busy || !replyText.trim()}>{t('إرسال رد', 'Send reply')}</button>
                  </form>
                </>
              ) : (
                <p className="muted">{t('اختر محادثة لعرضها.', 'Select a conversation.')}</p>
              )}
            </div>
          </div>
        </section>
      )}

      {tab === 'notifications' && (
        <>
          <section className="card">
            <h2>{t('القواعد والمناسبات', 'Rules & occasions')}</h2>
            <p className="small muted">{t('المتغيرات المدعومة: {name}، {gym}، {branch}، {expires}، {balance}، {date}، {occasion}.', 'Variables: {name}, {gym}, {branch}, {expires}, {balance}, {date}, {occasion}.')}</p>
            <form
              key={edit?.id ?? 'new'}
              onSubmit={async (e) => {
                e.preventDefault();
                const form = e.currentTarget;
                const f = new FormData(form);
                const rule = {
                  ...(edit ?? {}),
                  name: String(f.get('name')),
                  kind: f.get('kind'),
                  template: String(f.get('template')),
                  language: f.get('language'),
                  offset: Number(f.get('offset')),
                  time: String(f.get('time')),
                  enabled: f.get('enabled') === 'on',
                  parameters: String(f.get('parameters')).split('\n').map((x) => x.trim()).filter(Boolean),
                  ...(f.get('messageText') ? { messageText: String(f.get('messageText')) } : {}),
                  ...(f.get('date') ? { date: String(f.get('date')) } : {}),
                };
                if (await send({ action: 'rule', rule })) {
                  setEdit(null);
                  form.reset();
                }
              }}
            >
              <label>{t('اسم القاعدة', 'Rule name')}<input name="name" defaultValue={edit?.name} maxLength={100} required /></label>
              <label>{t('الحدث', 'Trigger')}<select name="kind" defaultValue={edit?.kind ?? 'welcome'}>{Object.entries(kinds).map(([key, label]) => <option key={key} value={key}>{label[ar ? 0 : 1]}</option>)}</select></label>
              <label>{t('أيام الغياب / قبل الانتهاء', 'Gap / offset days')}<input name="offset" type="number" min={1} max={90} defaultValue={edit?.offset ?? 7} required /></label>
              <label>{t('وقت الإرسال', 'Send time')}<input name="time" type="time" defaultValue={edit?.time ?? '09:00'} required /></label>
              <label>{t('تاريخ المناسبة فقط', 'Occasion date')}<input name="date" type="date" defaultValue={edit?.date} /></label>
              <label>{t('اسم قالب Meta', 'Meta template name')}<input name="template" pattern="[a-z0-9_]+" defaultValue={edit?.template ?? 'club_notice'} required /></label>
              <label>{t('لغة القالب', 'Language')}<select name="language" defaultValue={edit?.language ?? 'ar'}>{['ar', 'en', 'en_US', 'en_GB'].map((x) => <option key={x}>{x}</option>)}</select></label>
              <label>{t('متغيرات Meta (سطر لكل متغير)', 'Meta parameters')}<textarea name="parameters" defaultValue={edit?.parameters.join('\n') ?? '{name}\n{gym}'} maxLength={5000} /></label>
              <label>{t('نص رسالة WPPConnect (اختياري)', 'WPPConnect message text (optional)')}<textarea name="messageText" defaultValue={edit?.messageText ?? ''} maxLength={2000} placeholder={t('أهلاً {name} في {gym}، اشتراكك ينتهي في {expires}', 'Hi {name} at {gym}, membership expires {expires}')} /></label>
              <label><input name="enabled" type="checkbox" defaultChecked={edit?.enabled ?? false} />{t('تفعيل القاعدة', 'Enable rule')}</label>
              <button className="button primary" disabled={busy}>{t('حفظ القاعدة', 'Save rule')}</button>
            </form>
            {data?.rules.map((r) => (
              <div className="preference-row" key={r.id}>
                <span>{r.name} · {r.enabled ? t('مفعلة', 'Enabled') : t('متوقفة', 'Disabled')}</span>
                <button className="text-button" onClick={() => setEdit(r)}>{t('تعديل', 'Edit')}</button>
              </div>
            ))}
          </section>
          <section className="card">
            <h2>{t('موافقات الأعضاء', 'Member opt-in')}</h2>
            {state.members.filter((m) => m.branch === branch && !m.archived && !m.demo).map((m) => (
              <label className="preference-row" key={m.id}>
                <span>{m.name} · <bdi>{m.phone}</bdi></span>
                <input type="checkbox" checked={m.whatsapp?.enabled ?? false} disabled={busy} onChange={(e) => void mutate({ type: 'member.whatsapp.consent', id: m.id, enabled: e.target.checked })} />
              </label>
            ))}
          </section>
        </>
      )}

      {tab === 'autoreplies' && (
        <section className="card">
          <h2>{t('الردود التلقائية (قواعد محلية مجانية)', 'Auto-replies (rule-based)')}</h2>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const form = e.currentTarget;
              const f = new FormData(form);
              const rule = {
                name: String(f.get('name')),
                enabled: f.get('enabled') === 'on',
                keywords: String(f.get('keywords')).split(',').map((x) => x.trim()).filter(Boolean),
                replyText: String(f.get('replyText')),
                welcomeText: String(f.get('welcomeText') ?? ''),
                offHoursText: String(f.get('offHoursText') ?? ''),
                startHour: Number(f.get('startHour') || 8),
                endHour: Number(f.get('endHour') || 23),
                handoffToStaff: f.get('handoff') === 'on',
                cooldownMinutes: Number(f.get('cooldown') || 30),
              };
              if (await send({ action: 'autoreply.save', rule })) form.reset();
            }}
          >
            <label>{t('اسم الرد', 'Rule name')}<input name="name" required maxLength={100} /></label>
            <label>{t('الكلمات المفتاحية (مفصولة بفاصلة)', 'Keywords (comma-separated)')}<input name="keywords" placeholder={t('مواعيد, اسعار, اشتراك', 'hours, price, membership')} /></label>
            <label>{t('نص الرد', 'Reply text')}<textarea name="replyText" required maxLength={2000} /></label>
            <label>{t('رسالة الترحيب الأولى (اختياري)', 'First-message welcome (optional)')}<input name="welcomeText" maxLength={500} /></label>
            <label>{t('رسالة خارج ساعات العمل (اختياري)', 'Off-hours message (optional)')}<input name="offHoursText" maxLength={500} /></label>
            <div className="form-row">
              <label>{t('من الساعة', 'Start hour')}<input name="startHour" type="number" min={0} max={23} defaultValue={8} /></label>
              <label>{t('إلى الساعة', 'End hour')}<input name="endHour" type="number" min={0} max={23} defaultValue={23} /></label>
              <label>{t('فترة التهدئة (دقيقة)', 'Cooldown (min)')}<input name="cooldown" type="number" min={1} max={1440} defaultValue={30} /></label>
            </div>
            <label className="checkbox"><input type="checkbox" name="handoff" />{t('تحويل لموظف عند الحاجة', 'Handoff to staff')}</label>
            <label className="checkbox"><input type="checkbox" name="enabled" defaultChecked />{t('تفعيل الرد التلقائي', 'Enable rule')}</label>
            <button className="button primary" disabled={busy}>{t('حفظ الرد التلقائي', 'Save auto-reply')}</button>
          </form>
          {(data?.autoReplies ?? []).map((r) => (
            <div className="preference-row" key={r.id}>
              <span>{r.name} · [{r.keywords.join(', ')}] · {r.enabled ? t('مفعل', 'On') : t('متوقف', 'Off')}</span>
              <button className="text-button" disabled={busy} onClick={() => void send({ action: 'autoreply.delete', id: r.id })}>{t('حذف', 'Delete')}</button>
            </div>
          ))}
        </section>
      )}

      {tab === 'logs' && (
        <section className="card">
          <h2>{t('سجل الرسائل', 'Message Log')}</h2>
          <button className="button primary" disabled={busy} onClick={async () => { if (await confirm({ title: t('تشغيل وإرسال الرسائل المستحقة الآن؟', 'Enqueue & run due messages now?') })) void send({ action: 'run' }); }}>
            {t('تشغيل المستحق الآن', 'Run due messages now')}
          </button>
          {data?.outbox.map((j) => (
            <p key={j.id}>{state.members.find((m) => m.id === j.member_id)?.name ?? j.member_id} · {j.status} · {j.error ?? ''}</p>
          ))}
        </section>
      )}

      {tab === 'settings' && (
        <section className="card">
          <h2>{t('إعدادات المزود وحدود الإرسال', 'Provider & Rate Limit Settings')}</h2>
          <p className="small muted">
            {t(
              'تنبيه: WPPConnect تكامل غير رسمي يعتمد على جلسة واتساب ويب على خادم مستقل، ولا يمكن ضمان عدم فرض قيود من واتساب عند الاستخدام المكثف.',
              'Notice: WPPConnect is an unofficial integration running on an independent server; WhatsApp rate/account policies still apply.'
            )}
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              await send({ action: 'provider.select', provider: f.get('provider'), dailyLimit: Number(f.get('dailyLimit') || 250) });
            }}
          >
            <label>
              {t('مزود الإرسال لهذا الفرع', 'Branch provider')}
              <select name="provider" defaultValue={activeProvider}>
                <option value="meta">Meta Cloud API (Official)</option>
                <option value="wppconnect">WPPConnect Self-Hosted (QR)</option>
                <option value="manual">{t('الإرسال اليدوي فقط', 'Manual only')}</option>
              </select>
            </label>
            <label>
              {t('الحد الأقصى للرسائل اليومية', 'Daily message limit')}
              <input name="dailyLimit" type="number" min={1} max={5000} defaultValue={wpp?.daily_limit ?? 250} />
            </label>
            <button className="button primary" disabled={busy}>{t('حفظ الإعدادات', 'Save settings')}</button>
          </form>
        </section>
      )}

      {dialog}
    </section>
  );
}

export default function WhatsAppPanel(props: Parameters<typeof AutomaticWhatsAppPanel>[0]) {
  const [advanced, setAdvanced] = useState(false);
  if (!['owner', 'manager'].includes(props.role)) return <p>{props.ar ? 'للمالك والمدير فقط' : 'Owners and managers only'}</p>;
  return (
    <>
      <ManualWhatsApp state={props.state} owner={props.owner} branch={props.branch} ar={props.ar} mutate={props.mutate} />
      <details className="card" onToggle={(e) => setAdvanced(e.currentTarget.open)}>
        <summary>{props.ar ? 'تكامل واتساب الآلي (WPPConnect / Meta) — متقدم' : 'Automated WhatsApp integration (WPPConnect / Meta)'}</summary>
        {advanced && <AutomaticWhatsAppPanel {...props} />}
      </details>
    </>
  );
}
