import 'server-only';
import { randomUUID } from 'node:crypto';
import { getFirestoreDb } from './firestore-db.ts';
import { emptyState } from './domain';
import { CommercialError, licenseGrant, limits, priceMinor, type License } from './licensing';
import { OWNER_FREE_LIMITS, OWNER_FREE_PLAN } from './platform-owner-license';
import type { ChatGPTUser } from '../chatgpt-auth';
import type { CommercialClub, Order } from './commercial-types';

const DEFAULT_LIMITS = { branches: 5, members: 1000, staff: 20 };
const text = (value: unknown, max = 120) => { if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new CommercialError('invalid'); return value.trim(); };
const membershipId = (tenant: string, user: string) => `${tenant}_${user}`;
const database = () => getFirestoreDb();
const licenseRef = (id: string) => database().collection('tenant_licenses').doc(id);
const memberRef = (id: string, uid: string) => database().collection('tenant_memberships').doc(membershipId(id, uid));
const tenantRef = (id: string) => database().collection('tenants').doc(id);
const auditRef = () => database().collection('commercial_audit').doc();
const audit = (actor: string, tenant: string | null, action: string, details: unknown = {}) => ({ actor, tenant_id: tenant, action, details, at: new Date().toISOString() });
const defaultLicense = (id: string): License => ({ tenant_id: id, plan_id: 'custom', mode: 'monthly', status: 'pending', starts_at: null, ends_at: null, maintenance_until: null, limits: DEFAULT_LIMITS, revision: 0 });

export async function firebasePlatform(user: ChatGPTUser) {
  const record = await database().collection('platform_admins').doc(user.userId).get();
  return record.exists && record.data()?.user_id === user.userId && record.data()?.active === true;
}

export async function firebaseClub(user: ChatGPTUser, requested?: string) {
  if (!requested) throw new CommercialError('chooseClub', 409);
  const id = requested.startsWith('tenant:') ? requested.slice(7) : requested;
  const [membership, tenant, license] = await Promise.all([memberRef(id, user.userId).get(), tenantRef(id).get(), licenseRef(id).get()]);
  const access = membership.data(), club = tenant.data();
  if (!access || access.user_id !== user.userId || access.tenant_id !== id || access.revoked !== false || !club || !license.exists || !['owner', 'manager', 'reception'].includes(access.role)) throw new CommercialError('chooseClub', 409);
  return { id, storage_key: club.storage_key as string, name: club.name as string, role: access.role as 'owner' | 'manager' | 'reception', branches: access.branches as string[] | null, license: license.data() as License, support: undefined, platformOwnerAccess: false };
}

export async function firebaseDirectory(user: ChatGPTUser, platformView = false) {
  const platform = await firebasePlatform(user);
  if (platformView && !platform) throw new CommercialError('forbidden', 403);
  const memberships = platformView ? null : await database().collection('tenant_memberships').where('user_id', '==', user.userId).get();
  const all = platformView ? await database().collection('tenants').orderBy('created_at', 'desc').limit(500).get() : null;
  const ids = platformView ? all!.docs.map(doc => doc.id) : memberships!.docs.filter(doc => doc.data().revoked === false).map(doc => doc.data().tenant_id as string);
  const clubs: CommercialClub[] = [];
  for (const id of ids) {
    const [tenant, license] = await Promise.all([tenantRef(id).get(), licenseRef(id).get()]);
    if (!tenant.exists || !license.exists) continue;
    const role = platformView ? 'platform-observer' : memberships!.docs.find(doc => doc.data().tenant_id === id)?.data().role;
    const requests = role === 'owner' ? (await database().collection('activation_requests').where('tenant_id', '==', id).get()).docs.map(doc => doc.data() as Order) : [];
    const members = role === 'owner' ? (await database().collection('tenant_memberships').where('tenant_id', '==', id).get()).docs.filter(doc => doc.data().revoked === false).map(doc => doc.data() as { user_id: string; name: string; role: string }) : [];
    clubs.push({ id, name: tenant.data()!.name, role, license: license.data() as License, requests, members });
  }
  const [settings, trial, planDocs, orderDocs, eventDocs] = await Promise.all([
    database().collection('platform_settings').doc('primary').get(), database().collection('trial_claims').doc(user.userId).get(),
    platformView ? database().collection('commercial_plans').get() : null,
    platformView ? database().collection('activation_requests').orderBy('created_at', 'desc').limit(200).get() : null,
    platformView ? database().collection('commercial_audit').orderBy('at', 'desc').limit(100).get() : null,
  ]);
  return { account: { name: user.displayName, email: user.email }, platform, ownerComplimentary: platform, clubs, plans: planDocs?.docs.map(doc => doc.data()) || [], settings: settings.data() || { payload: { company: '', support: '', paymentInstructions: '', terms: '', privacy: '' }, revision: 0 }, orders: orderDocs?.docs.map(doc => doc.data()) || [], events: eventDocs?.docs.map(doc => doc.data()) || [], trialUsed: trial.exists };
}

export async function firebaseAction(user: ChatGPTUser, body: Record<string, unknown>) {
  const action = body.action, db = database();
  if (['settings', 'plan', 'quote', 'approve', 'reject', 'suspend', 'resume', 'club.update', 'club.delete'].includes(String(action))) {
    if (!await firebasePlatform(user)) throw new CommercialError('forbidden', 403);
    if (action === 'club.update') {
      const id = text(body.tenant), name = text(body.name, 120);
      await db.runTransaction(async tx => {
        const tSnap = await tx.get(tenantRef(id)), lSnap = await tx.get(licenseRef(id));
        if (!tSnap.exists || !lSnap.exists) throw new CommercialError('notFound', 404);
        const current = lSnap.data() as License;
        if (current.revision !== body.revision) throw new CommercialError('conflict', 409);
        const mode = ['trial', 'monthly', 'annual', 'perpetual'].includes(String(body.mode)) ? String(body.mode) : current.mode;
        const status = ['pending', 'active', 'suspended'].includes(String(body.status)) ? String(body.status) : current.status;
        const cap = body.limits ? limits(body.limits) : current.limits;
        const endsRaw = typeof body.ends_at === 'string' ? body.ends_at.trim() : '';
        const ends_at = mode === 'perpetual' || !endsRaw ? null : (Number.isFinite(Date.parse(endsRaw)) ? new Date(endsRaw.length === 10 ? endsRaw + 'T23:59:59.000Z' : endsRaw).toISOString() : (() => { throw new CommercialError('date'); })());
        tx.update(tenantRef(id), { name });
        tx.update(licenseRef(id), { mode, status, ends_at, limits: cap, revision: current.revision + 1, updated_at: new Date().toISOString() });
        tx.create(auditRef(), audit(user.userId, id, 'club.updated', { name, mode, status, ends_at, limits: cap }));
      });
      return { ok: true };
    }
    if (action === 'club.delete') {
      if (body.confirm !== 'DELETE_CLUB') throw new CommercialError('confirmation');
      const id = text(body.tenant);
      const tSnap = await tenantRef(id).get();
      if (!tSnap.exists) throw new CommercialError('notFound', 404);
      const tData = tSnap.data() as { storage_key?: string; name?: string } | undefined;
      const storageKey = tData?.storage_key || `tenant:${id}`;
      const deleteMatches = async (col: string, field: string, value: string) => {
        const snap = await db.collection(col).where(field, '==', value).get();
        for (let i = 0; i < snap.docs.length; i += 400) {
          const batch = db.batch();
          snap.docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
          await batch.commit();
        }
      };
      await deleteMatches('tenant_memberships', 'tenant_id', id);
      await deleteMatches('activation_requests', 'tenant_id', id);
      await deleteMatches('support_requests', 'tenant_id', id);
      for (const col of ['gym_entities', 'gym_photos', 'gym_workspace_deltas', 'workspace_outbox', 'gym_recovery', 'gym_access', 'member_faces']) {
        await deleteMatches(col, 'owner_id', storageKey);
      }
      const b = db.batch();
      b.delete(tenantRef(id));
      b.delete(licenseRef(id));
      b.delete(db.collection('open_orders').doc(id));
      b.delete(db.collection('gym_states').doc(storageKey));
      b.create(auditRef(), audit(user.userId, null, 'club.deleted', { tenant_id: id, name: tData?.name ?? '', note: typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '' }));
      await b.commit();
      return { ok: true };
    }
    if (action === 'settings') {
      const ref = db.collection('platform_settings').doc('primary');
      const payload = { company: text(body.company), support: String(body.support ?? '').slice(0, 300), paymentInstructions: String(body.paymentInstructions ?? '').slice(0, 4000), terms: String(body.terms ?? '').slice(0, 8000), privacy: String(body.privacy ?? '').slice(0, 8000) };
      await db.runTransaction(async tx => { const previous = await tx.get(ref), revision = previous.data()?.revision ?? 0; if (revision !== body.revision) throw new CommercialError('conflict', 409); tx.set(ref, { payload, revision: revision + 1 }); tx.create(auditRef(), audit(user.userId, null, 'settings.updated')); });
      return { ok: true };
    }
    if (action === 'plan') {
      const id = text(body.id, 50);
      if (!/^[a-z0-9-]+$/.test(id) || id === 'legacy') throw new CommercialError('invalid');
      const cap = limits(body.limits), name = text(body.name, 100), currency = text(body.currency, 3).toUpperCase();
      if (cap.branches > 100 || cap.members > 10000 || !/^[A-Z]{3}$/.test(currency)) throw new CommercialError('limits');
      const prices = ['monthly', 'annual', 'perpetual', 'maintenance'].map(mode => priceMinor(body[mode], true));
      const ref = db.collection('commercial_plans').doc(id);
      await db.runTransaction(async tx => { const previous = await tx.get(ref), revision = previous.data()?.revision ?? 0; if (revision !== (body.revision ?? 0)) throw new CommercialError('conflict', 409); tx.set(ref, { id, name, currency, monthly_minor: prices[0], annual_minor: prices[1], perpetual_minor: prices[2], maintenance_minor: prices[3], limits: cap, published: body.published === true, revision: revision + 1 }); tx.create(auditRef(), audit(user.userId, null, 'plan.saved', { id })); });
      return { ok: true };
    }
    if (action === 'suspend' || action === 'resume') {
      const id = text(body.tenant), ref = licenseRef(id), note = text(body.note, 1000);
      await db.runTransaction(async tx => { const previous = await tx.get(ref), license = previous.data() as License | undefined; if (!license || license.revision !== body.revision) throw new CommercialError('conflict', 409); tx.update(ref, { status: action === 'suspend' ? 'suspended' : 'active', revision: license.revision + 1, updated_at: new Date().toISOString() }); tx.create(auditRef(), audit(user.userId, id, `license.${action}`, { note })); });
      return { ok: true };
    }
    const ref = db.collection('activation_requests').doc(text(body.id)), review = text(body.note, 1000);
    await db.runTransaction(async tx => {
      const snapshot = await tx.get(ref), order = snapshot.data();
      if (!order) throw new CommercialError('notFound', 404);
      const openSlot = db.collection('open_orders').doc(order.tenant_id);
      const slot = await tx.get(openSlot);
      const licenseDoc = action === 'approve' ? await tx.get(licenseRef(order.tenant_id)) : null;
      const reference = String(order.transfer_ref ?? '').normalize('NFKC').replace(/\s+/g, '').toUpperCase();
      const usedRef = action === 'approve' && reference ? db.collection('transfer_refs').doc(reference) : null;
      const previousRef = usedRef ? await tx.get(usedRef) : null;
      if (action === 'quote') {
        if (order.status !== 'quote_requested') throw new CommercialError('conflict', 409);
        const amount = priceMinor(body.amount); if (amount === null || amount <= 0) throw new CommercialError('amount');
        tx.update(ref, { expected_minor: amount, status: 'awaiting_payment', review_note: review });
      } else {
        if (order.status !== 'pending_review') throw new CommercialError('conflict', 409);
        if (action === 'approve') {
          if (body.confirm !== 'VERIFIED_TRANSFER' || !reference || previousRef?.exists || order.expected_minor == null || order.paid_minor == null || BigInt(order.expected_minor) !== BigInt(order.paid_minor)) throw new CommercialError('paymentMismatch', 409);
          const current = licenseDoc?.data() as License | undefined; if (!current) throw new CommercialError('notFound', 404);
          const grant = licenseGrant(current, order.mode, new Date().toISOString());
          tx.create(usedRef!, { reference, order_id: order.id, tenant_id: order.tenant_id });
          tx.update(licenseRef(order.tenant_id), { ...grant, plan_id: order.mode === 'maintenance' ? current.plan_id : order.plan_id, status: 'active', limits: order.mode === 'maintenance' ? current.limits : limits(order.entitlements), revision: current.revision + 1, updated_at: new Date().toISOString() });
        }
        tx.update(ref, { status: action === 'approve' ? 'approved' : 'rejected', review_note: [order.review_note, review].filter(Boolean).join('\n\n'), reviewed_at: new Date().toISOString(), reviewed_by: user.userId });
        if (slot.data()?.order_id === order.id) tx.delete(openSlot);
      }
      tx.create(auditRef(), audit(user.userId, order.tenant_id, `order.${action}`, { id: order.id }));
    });
    return { ok: true };
  }
  if (action === 'create' || action === 'setup') {
    const name = text(body.name);
    if (action === 'setup' && (typeof body.requestId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(body.requestId) || typeof body.startTrial !== 'boolean')) throw new CommercialError('invalid');
    const id = action === 'setup' ? String(body.requestId) : randomUUID(), now = new Date().toISOString();
    // Verified platform owner (active platform_admins record): every club they
    // create carries the complimentary platform-owner license, mirroring the
    // Postgres ownerComplimentary flow. Never trusts a client-supplied flag.
    const complimentary = await firebasePlatform(user);
    const userClubs = await db.collection('tenant_memberships').where('user_id', '==', user.userId).get();
    if (!complimentary && userClubs.docs.filter(doc => doc.data().role === 'owner' && doc.data().revoked === false).length >= 20) throw new CommercialError('clubLimit', 403);
    const { seedNewClubDefaults } = await import('./club-defaults');
    const state = seedNewClubDefaults(emptyState(), now); state.settings.name = name;
    const created = await db.runTransaction(async tx => {
      const existing = await tx.get(tenantRef(id));
      const plan = await tx.get(db.collection('commercial_plans').doc('custom'));
      const ownerPlan = complimentary ? await tx.get(db.collection('commercial_plans').doc(OWNER_FREE_PLAN)) : null;
      if (existing.exists) { if (existing.data()?.created_by !== user.userId || existing.data()?.name !== name) throw new CommercialError('conflict', 409); return false; }
      if (!plan.exists) tx.create(db.collection('commercial_plans').doc('custom'), { id: 'custom', name: 'باقة حسب الاتفاق', currency: 'EGP', monthly_minor: null, annual_minor: null, perpetual_minor: null, maintenance_minor: null, limits: DEFAULT_LIMITS, published: true, revision: 0 });
      if (complimentary && !ownerPlan!.exists) tx.create(db.collection('commercial_plans').doc(OWNER_FREE_PLAN), { id: OWNER_FREE_PLAN, name: 'استخدام صاحب المنصة - مجاني', currency: 'EGP', monthly_minor: 0, annual_minor: 0, perpetual_minor: 0, maintenance_minor: 0, limits: OWNER_FREE_LIMITS, published: false, revision: 0 });
      tx.create(tenantRef(id), { id, name, storage_key: `tenant:${id}`, created_by: user.userId, created_at: now });
      tx.create(memberRef(id, user.userId), { tenant_id: id, user_id: user.userId, role: 'owner', name: user.displayName, branches: null, revoked: false });
      tx.create(licenseRef(id), complimentary
        ? { tenant_id: id, plan_id: OWNER_FREE_PLAN, mode: 'perpetual', status: 'active', starts_at: now, ends_at: null, maintenance_until: null, limits: OWNER_FREE_LIMITS, revision: 0 }
        : defaultLicense(id));
      tx.create(db.collection('gym_states').doc(`tenant:${id}`), { user_id: `tenant:${id}`, payload: JSON.stringify(state), revision: 0, updated_at: now });
      tx.create(auditRef(), audit(user.userId, id, 'club.created'));
      if (complimentary) tx.create(auditRef(), audit(user.userId, id, 'license.owner_complimentary', { reason: 'Verified platform owner personal club; no charge or renewal' }));
      return true;
    });
    if (created && action === 'setup' && body.startTrial && !complimentary) await firebaseAction(user, { action: 'trial.start', tenant: id });
    return { id };
  }
  const id = text(body.tenant), club = await firebaseClub(user, id);
  if (action === 'select') return { id: club.id };
  if (club.role !== 'owner') throw new CommercialError('forbidden', 403);
  if (action === 'owner.add' || action === 'owner.remove') {
    if (body.confirm !== 'CHANGE_OWNERSHIP') throw new CommercialError('confirmation');
    const target = text(body.user, 128), member = memberRef(club.id, target), staff = db.collection('gym_access').doc(`${club.storage_key}_${target}`);
    await db.runTransaction(async tx => {
      const [current, staffDoc, owners] = await Promise.all([
        tx.get(member), tx.get(staff), tx.get(db.collection('tenant_memberships').where('tenant_id', '==', club.id).where('role', '==', 'owner')),
      ]);
      const access = current.data();
      if (!access || access.revoked !== false) throw new CommercialError('notFound', 404);
      if (action === 'owner.add') {
        if (access.role === 'owner') throw new CommercialError('conflict', 409);
        tx.update(member, { role: 'owner', branches: null });
        if (staffDoc.exists) tx.update(staff, { revoked: true });
      } else {
        if (access.role !== 'owner') throw new CommercialError('invalid');
        if (owners.docs.filter(doc => doc.data().revoked === false).length <= 1) throw new CommercialError('lastOwner', 409);
        tx.update(member, { revoked: true });
        if (staffDoc.exists) tx.update(staff, { revoked: true });
      }
      tx.create(auditRef(), audit(user.userId, club.id, String(action), { user: target }));
    });
    return { ok: true };
  }
  if (action === 'trial.start') {
    const claim = db.collection('trial_claims').doc(user.userId);
    return db.runTransaction(async tx => {
      const [claimed, current] = await Promise.all([tx.get(claim), tx.get(licenseRef(club.id))]);
      const license = current.data() as License;
      if (claimed.exists) throw new CommercialError('trialUsed', 409);
      if (!license || license.status !== 'pending') throw new CommercialError('trialUnavailable', 409);
      const grant = licenseGrant(license, 'trial', new Date().toISOString());
      tx.create(claim, { owner_id: user.userId, tenant_id: club.id, at: new Date().toISOString() });
      tx.update(licenseRef(club.id), { ...grant, status: 'active', mode: 'trial', revision: license.revision + 1 });
      tx.create(auditRef(), audit(user.userId, club.id, 'trial.started'));
      return { ok: true, startsAt: grant.starts_at, endsAt: grant.ends_at, id: club.id };
    });
  }
  if (action === 'order') {
    const mode = body.mode;
    if (!['monthly', 'annual', 'perpetual', 'maintenance'].includes(String(mode))) throw new CommercialError('invalid');
    if (mode === 'maintenance' && club.license.mode !== 'perpetual') throw new CommercialError('maintenanceRequiresPerpetual');
    const orderId = randomUUID();
    const slot = db.collection('open_orders').doc(club.id);
    await db.runTransaction(async tx => {
      if ((await tx.get(slot)).exists) throw new CommercialError('openRequest', 409);
      tx.create(slot, { tenant_id: club.id, order_id: orderId });
      tx.create(db.collection('activation_requests').doc(orderId), { id: orderId, tenant_id: club.id, user_id: user.userId, plan_id: club.license.plan_id, mode, status: 'quote_requested', expected_minor: null, paid_minor: null, currency: 'EGP', entitlements: club.license.limits, created_at: new Date().toISOString() });
    });
    return { ok: true };
  }
  if (action === 'transfer' || action === 'cancel') {
    const orderId = text(body.id), ref = db.collection('activation_requests').doc(orderId);
    await db.runTransaction(async tx => {
      const snap = await tx.get(ref), order = snap.data();
      if (!order || order.tenant_id !== club.id) throw new CommercialError('notFound', 404);
      const slot = db.collection('open_orders').doc(club.id), active = await tx.get(slot);
      if (action === 'cancel') { if (!['quote_requested', 'awaiting_payment', 'pending_review'].includes(order.status)) throw new CommercialError('conflict', 409); tx.update(ref, { status: 'cancelled' }); if (active.data()?.order_id === orderId) tx.delete(slot); }
      else {
        if (order.status !== 'awaiting_payment') throw new CommercialError('conflict', 409);
        const day = text(body.day, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || day > new Date().toISOString().slice(0, 10)) throw new CommercialError('date');
        tx.update(ref, { transfer_ref: text(body.reference, 200).normalize('NFKC').replace(/\s+/g, '').toUpperCase(), transfer_day: day, paid_minor: priceMinor(body.amount), note: String(body.note ?? '').slice(0, 1000), status: 'pending_review' });
      }
      tx.create(auditRef(), audit(user.userId, club.id, `order.${action}`, { id: orderId }));
    });
    return { ok: true };
  }
  throw new CommercialError('invalid');
}
