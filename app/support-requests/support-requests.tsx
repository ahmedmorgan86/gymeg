'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { canAccessSupportRequest, type SupportRequest } from '../lib/support-requests';

type Ticket = SupportRequest & { id: string };
type Thread = { request: Ticket; messages: { id: string; author: string; text: string; at: string }[] };
type Update = { id: string; requestId: string; type: 'claim' | 'reply' | 'resolve' };
const statusLabels = { open: 'مفتوح', in_progress: 'قيد المتابعة', resolved: 'تم الحل' };

async function loadJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init });
  if (!response.ok) throw Error(String(response.status));
  return response.json();
}

export default function SupportRequests({ platform, userId, available }: { platform: boolean; userId: string; available: boolean }) {
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [updates, setUpdates] = useState<Update[]>([]);
  const [selected, setSelected] = useState('');
  const [thread, setThread] = useState<Thread | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const endpoint = '/api/support-requests?platform=' + (platform ? '1' : '0');
  const getThread = useCallback((id: string, signal?: AbortSignal) => loadJson<Thread>(endpoint + '&id=' + encodeURIComponent(id), { signal }), [endpoint]);

  useEffect(() => {
    if (!available) return;
    const abort = new AbortController();
    async function refresh() {
      try {
        const [data, activity] = await Promise.all([
          loadJson<{ requests: Ticket[] }>(endpoint, { signal: abort.signal }),
          loadJson<{ updates: Update[] }>(endpoint + '&updates=1', { signal: abort.signal }),
        ]);
        if (!abort.signal.aborted) {
          setTickets(data.requests);
          setUpdates(activity.updates);
        }
      } catch {
        if (!abort.signal.aborted) setError('تعذر تحميل طلبات الدعم. أعد المحاولة.');
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 20000);
    return () => { abort.abort(); window.clearInterval(timer); };
  }, [available, endpoint]);

  useEffect(() => {
    if (!selected) return;
    const abort = new AbortController();
    void getThread(selected, abort.signal).then(data => {
      if (!abort.signal.aborted) setThread(data);
    }).catch(() => { if (!abort.signal.aborted) setError('تعذر فتح طلب الدعم.'); });
    return () => abort.abort();
  }, [getThread, selected]);

  async function mutate(body: object) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await loadJson<{ id: string }>(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      setSelected(result.id);
      setThread(await getThread(result.id));
      const data = await loadJson<{ requests: Ticket[] }>(endpoint);
      setTickets(data.requests);
      return true;
    } catch {
      setError('تعذر تنفيذ الطلب. تحقق من صلاحياتك وحالة الطلب ثم أعد المحاولة.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    const body = form.dataset.kind === 'create'
      ? { action: 'create', title: fields.get('title'), message: fields.get('message') }
      : { action: 'reply', id: selected, message: fields.get('message') };
    if (await mutate(body)) form.reset();
  }

  const current = thread?.request.id === selected ? thread : null;
  const actor = { id: userId, platform };
  return <main dir="rtl" lang="ar" style={{ maxWidth: '52rem', margin: '2rem auto', padding: '0 1rem', display: 'grid', gap: '1rem' }}>
    <Link href={platform ? '/platform' : '/clubs'}>رجوع</Link>
    <h1>طلبات الدعم</h1>
    {!available && <p role="status">طلبات الدعم غير متاحة على إعداد التخزين الحالي.</p>}
    {error && <p role="alert">{error}</p>}
    {available && !platform && <form className="card" data-kind="create" onSubmit={submit}>
      <h2>طلب دعم جديد</h2>
      <p><label>عنوان الطلب <input name="title" required minLength={3} maxLength={120} /></label></p>
      <p><label>وصف المشكلة <textarea name="message" required maxLength={2000} rows={4} /></label></p>
      <button type="submit" className="button primary" disabled={busy}>إرسال الطلب</button>
    </form>}
    {!!updates.length && <section aria-label="آخر تحديثات الدعم">
      <h2>آخر تحديثات الدعم</h2>
      <ul>{updates.map(update => <li key={update.id}><button type="button" disabled={busy} onClick={() => setSelected(update.requestId)}>
        {update.type === 'claim' ? 'فريق الدعم بدأ متابعة طلبك' : update.type === 'reply' ? 'رد جديد على طلب دعم' : 'تم حل طلب دعم'}
      </button></li>)}</ul>
    </section>}
    {available && <section aria-label="الطلبات">
      {tickets === null ? <p aria-busy={!error}>{error ? 'تعذر تحميل القائمة' : 'جارٍ التحميل…'}</p>
        : tickets.length === 0 ? <p>مفيش طلبات دعم حاليًا.</p>
        : <ul>{tickets.map(ticket => <li key={ticket.id}><button type="button" className="button secondary"
          disabled={busy} aria-pressed={selected === ticket.id} onClick={() => { setSelected(ticket.id); setError(''); }}>
          {ticket.title} · {statusLabels[ticket.status]}
        </button></li>)}</ul>}
    </section>}
    {current && <section className="card">
      <h2>{current.request.title}</h2>
      <p>{statusLabels[current.request.status]}</p>
      {canAccessSupportRequest(current.request, actor, 'claim') && <button type="button" disabled={busy}
        onClick={() => void mutate({ id: selected, action: 'claim' })}>تولّي الطلب</button>}
      {canAccessSupportRequest(current.request, actor, 'resolve') && <button type="button" disabled={busy}
        onClick={() => void mutate({ id: selected, action: 'resolve' })}>تحديد كمحلول</button>}
      <ol>{current.messages.map(item => <li key={item.id}>
        <b>{item.author === userId ? 'أنت' : item.author === current.request.requester ? 'صاحب الطلب' : 'الدعم'}</b>
        <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.text}</p>
      </li>)}</ol>
      {canAccessSupportRequest(current.request, actor, 'reply') && <form onSubmit={submit}>
        <p><label>الرد <textarea name="message" required maxLength={2000} rows={3} /></label></p>
        <button type="submit" className="button primary" disabled={busy}>إرسال الرد</button>
      </form>}
    </section>}
  </main>;
}
