import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { getFirestoreDb } from './firestore-db.ts';
import { firebaseMemberLicense } from './firebase-member-auth';
import { readSpace } from './server-workspace';
import { dueMessages, templateMessage, whatsappPhone, whatsappRule, type WhatsAppRule } from './whatsapp';
import { licenseState, type License } from './licensing';
import { normalizeLicense } from './commercial';
const whatsappPhoneDigest = (raw: string) => { const normalized = whatsappPhone(raw.startsWith('+') ? raw : '+' + raw); return normalized ? createHash('sha256').update(normalized).digest('hex') : null; };
const webhookEventKey = (...parts: string[]) => createHash('sha256').update(parts.join('|')).digest('hex');

const key = () => {
  const secret = Buffer.from(process.env.GYMEG_WHATSAPP_TOKEN_KEY ?? '', 'base64');
  if (secret.length !== 32) throw Error('WhatsApp token encryption is not configured');
  return Buffer.from(hkdfSync('sha256', secret, Buffer.from('gymeg-whatsapp'), Buffer.from('connection-token-v1'), 32));
};
export function whatsappEncryptionReady() { try { key(); return true; } catch { return false; } }
function seal(token: string) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), iv); const body = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]); return [iv, cipher.getAuthTag(), body].map(x => x.toString('base64url')).join('.'); }
function open(value: string) { const parts = value.split('.'); if (parts.length !== 3) throw Error('invalid WhatsApp credential'); const cipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(parts[0], 'base64url')); cipher.setAuthTag(Buffer.from(parts[1], 'base64url')); return Buffer.concat([cipher.update(Buffer.from(parts[2], 'base64url')), cipher.final()]).toString('utf8'); }
const id = (...parts: string[]) => createHash('sha256').update(parts.join('\0')).digest('hex');
const db = () => getFirestoreDb();
const connection = (owner: string, branch: string) => db().collection('whatsapp_connections').doc(id(owner, branch));
const outbox = () => db().collection('whatsapp_outbox');
const rules = () => db().collection('whatsapp_rules');

export async function whatsappSettings(owner: string, branch: string) {
  const [c, r, o] = await Promise.all([
    connection(owner, branch).get(),
    rules().where('owner_id', '==', owner).where('branch', '==', branch).limit(101).get(),
    outbox().where('owner_id', '==', owner).where('branch', '==', branch).orderBy('updated_at', 'desc').limit(100).get()
  ]);
  const data = c.data();
  return { connection: data ? { phone_id: data.phone_id, api_version: data.api_version, updated_at: data.updated_at } : null, rules: r.docs.map(d => d.data().payload), outbox: o.docs.map(d => { const v = d.data(); return { id: d.id, member_id: v.member_id, status: v.status, error: v.error ?? null, updated_at: v.updated_at }; }) };
}
export async function connectWhatsApp(owner: string, branch: string, phone: string, version: string, token: string) {
  await connection(owner, branch).set({ owner_id: owner, branch, phone_id: phone, api_version: version, token_cipher: seal(token), updated_at: new Date().toISOString(), last_run_at: '1970-01-01T00:00:00.000Z' });
}
export async function disconnectWhatsApp(owner: string, branch: string) {
  await connection(owner, branch).delete();
  const pending = await outbox().where('owner_id', '==', owner).where('branch', '==', branch).where('status', '==', 'pending').limit(501).get();
  if (pending.size > 500) throw Error('WhatsApp pending capacity exceeded');
  const batch = db().batch(); for (const doc of pending.docs) batch.update(doc.ref, { status: 'cancelled', updated_at: new Date().toISOString() }); await batch.commit();
}
export async function saveWhatsAppRule(owner: string, branch: string, input: unknown) {
  const candidate = input as { id?: unknown } | null;
  const ref = typeof candidate?.id === 'string' ? rules().doc(id(owner, candidate.id)) : null;
  const previous = ref ? await ref.get() : null;
  if (previous?.exists && (previous.data()?.owner_id !== owner || previous.data()?.branch !== branch)) throw Error('forbidden');
  if (!previous?.exists) { const count = await rules().where('owner_id', '==', owner).limit(101).get(); if (count.size >= 100) return false; }
  const payload = previous?.data()?.payload as WhatsAppRule | undefined;
  const rule = whatsappRule.parse({ ...candidate, id: payload?.id ?? crypto.randomUUID(), branch, createdAt: payload?.createdAt ?? new Date().toISOString() });
  await rules().doc(id(owner, rule.id)).set({ owner_id: owner, branch, payload: rule, updated_at: new Date().toISOString() });
  return true;
}
export async function whatsappOwners() {
  const snap = await db().collection('whatsapp_connections').orderBy('last_run_at').limit(500).get();
  const owners = [...new Set(snap.docs.map(d => String(d.data().owner_id)))];
  return owners.slice(0, 100);
}
export async function markWhatsAppRun(owner: string) {
  const snap = await db().collection('whatsapp_connections').where('owner_id', '==', owner).limit(101).get();
  if (snap.size > 100) throw Error('WhatsApp connection capacity exceeded');
  const batch = db().batch(); for (const doc of snap.docs) batch.update(doc.ref, { last_run_at: new Date().toISOString() }); await batch.commit();
}
export async function whatsappOptedOutFirestore(owner: string, phoneHash: string) { return (await db().collection('whatsapp_optouts').doc(id(owner, phoneHash)).get()).exists; }

export async function runWhatsAppFirestore(owner: string, branch?: string, deadline = Date.now() + 40000) {
  if (!whatsappEncryptionReady()) return { sent: 0, blocked: true };
  const license = await firebaseMemberLicense(owner); if (license && !licenseState(normalizeLicense(license as License)).writable) return { sent: 0, blocked: true };
  const { state } = await readSpace(owner);
  const query = rules().where('owner_id', '==', owner).limit(101);
  const all = await query.get(); if (all.size > 100) throw Error('WhatsApp rule capacity exceeded');
  for (const doc of all.docs) {
    const parsed = whatsappRule.safeParse(doc.data().payload); if (!parsed.success || branch && parsed.data.branch !== branch) continue;
    for (const job of dueMessages(state, parsed.data, new Date().toISOString())) {
      const ref = outbox().doc(id(owner, parsed.data.id, job.member, job.occurrence));
      try { await ref.create({ owner_id: owner, branch: parsed.data.branch, member_id: job.member, rule_id: parsed.data.id, occurrence: job.occurrence, status: 'pending', payload: { to: job.to, parameters: job.parameters }, updated_at: new Date().toISOString() }); }
      catch (error) { if ((error as { code?: number }).code !== 6) throw error; }
    }
  }
  const pending = await outbox().where('owner_id', '==', owner).where('status', '==', 'pending').orderBy('updated_at').limit(21).get();
  if (pending.size > 20) throw Error('WhatsApp pending batch capacity exceeded');
  let sent = 0;
  for (const doc of pending.docs) {
    if (Date.now() >= deadline) break;
    const job = doc.data(); if (branch && job.branch !== branch) continue;
    const claim = await db().runTransaction(async tx => { const fresh = await tx.get(doc.ref); if (fresh.data()?.status !== 'pending') return false; tx.update(doc.ref, { status: 'sending', updated_at: new Date().toISOString() }); return true; });
    if (!claim) continue;
    let status = 'unknown', provider: string | null = null, error: string | null = 'delivery_unconfirmed_do_not_retry_automatically';
    try {
      const [current, conn, ruleDoc] = await Promise.all([readSpace(owner), connection(owner, job.branch).get(), rules().doc(id(owner, job.rule_id)).get()]);
      const member = current.state.members.find(m => m.id === job.member_id && m.branch === job.branch && !m.archived && !m.demo);
      const rule = whatsappRule.safeParse(ruleDoc.data()?.payload);
      const due = rule.success ? dueMessages(current.state, rule.data, new Date().toISOString()).find(x => x.member === job.member_id && x.occurrence === job.occurrence) : null;
      const phoneHash = whatsappPhoneDigest(String(job.payload?.to ?? ''));
      if (!conn.exists || !member?.whatsapp?.enabled || whatsappPhone(member.phone) !== job.payload?.to || !due || phoneHash && await whatsappOptedOutFirestore(owner, phoneHash)) { status = 'cancelled'; error = null; }
      else if (rule.success) {
        const c = conn.data()!;
        const response = await fetch(`https://graph.facebook.com/${c.api_version}/${c.phone_id}/messages`, { method: 'POST', headers: { Authorization: 'Bearer ' + open(c.token_cipher), 'Content-Type': 'application/json' }, body: JSON.stringify(templateMessage(rule.data, due.to, due.parameters)), signal: AbortSignal.timeout(15000) });
        const data = await response.json();
        if (response.ok && typeof data.messages?.[0]?.id === 'string') { status = 'sent'; provider = data.messages[0].id; error = null; sent++; }
        else { status = 'failed'; error = 'provider_' + String(data.error?.code ?? response.status).slice(0, 30); }
      }
    } catch { /* An unknown outcome is never retried automatically. */ }
    await doc.ref.update({ status, provider_id: provider, error, updated_at: new Date().toISOString() });
  }
  return { sent };
}

export async function consumeWhatsAppWebhookFirestore(payload: unknown) {
  const result = { optouts: 0, statuses: 0, duplicates: 0, ignored: 0 };
  if (!payload || typeof payload !== 'object' || (payload as {object?:unknown}).object !== 'whatsapp_business_account') return result;
  const entries = (payload as {entry?:unknown}).entry; if (!Array.isArray(entries)) return result;
  for (const entry of entries.slice(0, 50)) for (const change of (Array.isArray(entry?.changes) ? entry.changes : []).slice(0, 50)) {
    if (change?.field !== 'messages') continue;
    const value = change.value; const phone = value?.metadata?.phone_number_id;
    if (typeof phone !== 'string' || !/^[0-9]{5,30}$/.test(phone)) { result.ignored++; continue; }
    const connections = await db().collection('whatsapp_connections').where('phone_id', '==', phone).limit(101).get();
    if (connections.size > 100) throw Error('WhatsApp connection capacity exceeded');
    for (const message of (Array.isArray(value.messages) ? value.messages : []).slice(0, 200)) {
      if (typeof message?.text?.body !== 'string' || !/^(stop|unsubscribe|cancel|end)$/i.test(message.text.body.trim())) continue;
      const digest = typeof message.from === 'string' ? whatsappPhoneDigest(message.from) : null;
      if (!digest) { result.ignored++; continue; }
      const event = webhookEventKey('optout', String(message.id ?? ''), phone, digest);
      for (const conn of connections.docs) {
        const owner = conn.data().owner_id as string, eventRef = db().collection('whatsapp_webhook_events').doc(id(owner, event)), optout = db().collection('whatsapp_optouts').doc(id(owner, digest));
        const applied = await db().runTransaction(async tx => { if ((await tx.get(eventRef)).exists) return false; tx.create(eventRef, { owner_id: owner, at: new Date().toISOString() }); tx.set(optout, { owner_id: owner, phone_hash: digest, at: new Date().toISOString() }); return true; });
        if (applied) result.optouts++; else result.duplicates++;
      }
    }
    for (const item of (Array.isArray(value.statuses) ? value.statuses : []).slice(0, 200)) {
      if (typeof item?.id !== 'string' || item.id.length > 255 || !['sent', 'delivered', 'read', 'failed'].includes(item.status)) { result.ignored++; continue; }
      for (const conn of connections.docs) {
        const owner = conn.data().owner_id as string, eventRef = db().collection('whatsapp_webhook_events').doc(id(owner, webhookEventKey('status', item.id, item.status)));
        const match = await outbox().where('owner_id', '==', owner).where('provider_id', '==', item.id).limit(2).get();
        if (match.size > 1) throw Error('ambiguous WhatsApp provider ID');
        const applied = await db().runTransaction(async tx => {
          if ((await tx.get(eventRef)).exists) return false;
          tx.create(eventRef, { owner_id: owner, provider_id: item.id, status: item.status, at: new Date().toISOString() });
          if (match.size === 1) tx.update(match.docs[0].ref, { provider_status: item.status, updated_at: new Date().toISOString() });
          return true;
        });
        if (applied) result.statuses++; else result.duplicates++;
      }
    }
  }
  return result;
}
