import 'server-only';
import { getFirestoreDb } from './firestore-db.ts';
import { legacyBranchScope, type Role } from './access';

export type StaffRecord = { owner_id: string; user_id: string; name: string; role: Exclude<Role, 'owner'>; branches: string[]; revoked: boolean | 0 | 1 };
const accessId = (owner: string, user: string) => `${owner}_${user}`;
const access = (owner: string, user: string) => getFirestoreDb().collection('gym_access').doc(accessId(owner, user));

export async function staffMembership(owner: string, user: string): Promise<StaffRecord | null> {
  const snapshot = await access(owner, user).get();
  const value = snapshot.data() as StaffRecord | undefined;
  return value?.owner_id === owner && value.user_id === user && (value.revoked === false || value.revoked === 0) && ['manager', 'reception'].includes(value.role)
    ? { ...value, branches: legacyBranchScope(value.branches, value.role) ?? [] }
    : null;
}

export async function listStaff(owner: string, tenant?: string) {
  const database = getFirestoreDb();
  const [staff, events] = await Promise.all([
    (tenant ? database.collection('tenant_memberships').where('tenant_id', '==', tenant) : database.collection('gym_access').where('owner_id', '==', owner)).get(),
    database.collection('gym_access_events').where('owner_id', '==', owner).orderBy('at', 'desc').limit(100).get(),
  ]);
  return { staff: staff.docs.map(doc => doc.data()), audit: events.docs.map(doc => doc.data()) };
}

export async function createInvite(owner: string, actor: string, hash: string, role: 'manager' | 'reception', branches: string[], expires: string) {
  const database = getFirestoreDb();
  const batch = database.batch();
  batch.create(database.collection('gym_invites').doc(hash), { token_hash: hash, owner_id: owner, role, branches: JSON.stringify(branches), expires_at: expires, claimed_by: null });
  batch.create(database.collection('gym_access_events').doc(), { owner_id: owner, actor, target: 'invitation', action: 'invite', at: new Date().toISOString(), details: { role, branches } });
  await batch.commit();
}

export async function claimInvite(hash: string, user: { userId: string; displayName: string }, commercial: boolean): Promise<string | null> {
  const database = getFirestoreDb();
  const invitation = database.collection('gym_invites').doc(hash);
  return database.runTransaction(async tx => {
    const snapshot = await tx.get(invitation);
    const value = snapshot.data();
    if (!value || value.claimed_by || Date.parse(value.expires_at) <= Date.now() || !['manager', 'reception'].includes(value.role) || typeof value.owner_id !== 'string' || (!commercial && value.owner_id === user.userId)) return null;
    const member = access(value.owner_id, user.userId);
    const tenant = commercial && value.owner_id.startsWith('tenant:') ? value.owner_id.slice(7) : null;
    const commercialMember = tenant ? database.collection('tenant_memberships').doc(`${tenant}_${user.userId}`) : null;
    // Read all documents before starting transaction writes.
    await tx.get(member);
    if (commercialMember) await tx.get(commercialMember);
    const branches = JSON.parse(value.branches);
    if (!Array.isArray(branches) || !branches.every((branch: unknown) => typeof branch === 'string')) return null;
    tx.update(invitation, { claimed_by: user.userId });
    tx.set(member, { owner_id: value.owner_id, user_id: user.userId, name: user.displayName, role: value.role, branches, revoked: false });
    if (commercialMember) tx.set(commercialMember, { tenant_id: tenant, user_id: user.userId, name: user.displayName, role: value.role, branches, revoked: false });
    tx.create(database.collection('gym_access_events').doc(), { owner_id: value.owner_id, actor: user.userId, target: user.userId, action: 'claim', at: new Date().toISOString(), details: { role: value.role, branches } });
    return value.owner_id as string;
  });
}

export async function changeStaff(owner: string, actor: string, user: string, action: 'update' | 'restore' | 'revoke', change?: { name: string; role: string; branches: string[] }, tenant?: string): Promise<boolean> {
  const database = getFirestoreDb();
  const member = access(owner, user);
  const commercialMember = tenant ? database.collection('tenant_memberships').doc(`${tenant}_${user}`) : null;
  return database.runTransaction(async tx => {
    const snapshot = await tx.get(member);
    const commercialSnapshot = commercialMember ? await tx.get(commercialMember) : null;
    const previous = snapshot.data();
    if (!previous || previous.owner_id !== owner || previous.user_id !== user || (commercialMember && (!commercialSnapshot?.exists || commercialSnapshot.data()?.tenant_id !== tenant || commercialSnapshot.data()?.user_id !== user || commercialSnapshot.data()?.role === 'owner'))) return false;
    const fields = action === 'revoke' ? { revoked: true } : { name: change!.name, role: change!.role, branches: change!.branches, ...(action === 'restore' ? { revoked: false } : {}) };
    tx.update(member, fields);
    if (commercialMember) tx.update(commercialMember, fields);
    tx.create(database.collection('gym_access_events').doc(), { owner_id: owner, actor, target: user, action, at: new Date().toISOString(), details: { before: previous, requested: change || {} } });
    return true;
  });
}
