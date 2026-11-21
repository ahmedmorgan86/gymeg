import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { getFirestoreDb } from './firestore-db.ts';
import { normalizeMemberPhone } from './member-phone.ts';
const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');

const key = () => {
  const value = Buffer.from(process.env.GYMEG_MEMBER_PIN_KEY || '', 'base64');
  if (value.length !== 32) throw Error('Member credential encryption is not configured');
  return value;
};
const derived = (purpose: string) => Buffer.from(hkdfSync('sha256', key(), Buffer.alloc(0), purpose, 32));
const digest = (owner: string, member: string) => createHash('sha256').update(owner + '\0' + member).digest('hex');
export const memberAccessRef = (owner: string, member: string) => getFirestoreDb().collection('member_code_access').doc(digest(owner, member));
export const memberPortalRef = (owner: string, member: string) => getFirestoreDb().collection('member_portal_access').doc(digest(owner, member));
export const memberSessionRef = (token: string) => getFirestoreDb().collection('member_code_sessions').doc(hashToken(token));
export const phoneDigest = (phone: string) => createHmac('sha256', derived('gymeg-member-phone-v1')).update(phone).digest('hex');
export function pinDigest(pin: string, salt: string) { return createHmac('sha256', derived('gymeg-member-pin-v1')).update(salt + ':' + pin).digest('hex'); }
export function pinMatches(pin: string, stored: { pin_hash?: string; pin_salt?: string }) {
  if (!stored.pin_hash || !stored.pin_salt || !/^[a-f0-9]{64}$/.test(stored.pin_hash)) return false;
  return timingSafeEqual(Buffer.from(stored.pin_hash, 'hex'), Buffer.from(pinDigest(pin, stored.pin_salt), 'hex'));
}
export function protectPin(pin: string) {
  const salt = randomBytes(16).toString('hex'), iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', derived('gymeg-member-pin-display-v1'), iv);
  const payload = Buffer.concat([cipher.update(pin, 'utf8'), cipher.final()]);
  return { pin_hash: pinDigest(pin, salt), pin_salt: salt, pin_cipher: [iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), payload.toString('base64url')].join('.') };
}
export function revealPin(value: string | null | undefined) {
  if (!value) return null;
  const [iv, tag, ciphertext] = value.split('.');
  if (!iv || !tag || !ciphertext) throw Error('Invalid member PIN ciphertext');
  const decipher = createDecipheriv('aes-256-gcm', derived('gymeg-member-pin-display-v1'), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}
export async function firebaseMemberLicense(owner: string) {
  if (!owner.startsWith('tenant:')) return null;
  const snapshot = await getFirestoreDb().collection('tenant_licenses').doc(owner.slice(7)).get();
  return snapshot.data() || null;
}
export async function firebaseMemberIdentity(token: string) {
  const session = await memberSessionRef(token).get(), record = session.data();
  if (!record || Date.parse(record.expires_at) <= Date.now()) return null;
  const access = (await memberAccessRef(record.owner_id, record.member_id).get()).data();
  if (!access || access.revoked || access.inactive || access.version !== record.version) return null;
  return { owner_id: record.owner_id as string, member_id: record.member_id as string, branch: access.branch as string, version: access.version as number, pin_must_change: access.pin_must_change as boolean };
}
export async function recordMemberAttempt(bucket: string, limit: number) {
  const ref = getFirestoreDb().collection('member_code_attempts').doc(hashToken(bucket));
  return getFirestoreDb().runTransaction(async tx => {
    const snapshot = await tx.get(ref), previous = snapshot.data(), now = Date.now();
    const count = !previous || Date.parse(previous.started_at) < now - 15 * 60_000 ? 1 : previous.attempts + 1;
    tx.set(ref, { attempts: count, started_at: count === 1 ? new Date(now).toISOString() : previous!.started_at });
    return count <= limit;
  });
}
export async function registerMemberSession(token: string, owner: string, member: string, version: number) {
  await memberSessionRef(token).create({ owner_id: owner, member_id: member, version, expires_at: new Date(Date.now() + 7 * 86400_000).toISOString() });
}
export function memberCredentialFor(member: { id: string; branch: string; phone: string }, pin: string, version = 1) {
  const phone = normalizeMemberPhone(member.phone);
  return { member_id: member.id, branch: member.branch, phone_hash: phone ? phoneDigest(phone) : null, ...protectPin(pin), pin_must_change: true, version, revoked: false, inactive: false };
}

export async function firebaseChangeMemberPin(owner: string, member: string, version: number, current: string, next: string, oldToken: string, freshToken: string) {
  if (!await recordMemberAttempt('pin-change:' + oldToken, 5)) return 429;
  const ref = memberAccessRef(owner, member);
  return getFirestoreDb().runTransaction(async tx => {
    const snapshot = await tx.get(ref), record = snapshot.data();
    if (!record || record.revoked || record.inactive || record.version !== version || !pinMatches(current, record)) return 401;
    const nextVersion = version + 1, protectedPin = protectPin(next);
    tx.update(ref, { pin_hash: protectedPin.pin_hash, pin_salt: protectedPin.pin_salt, pin_cipher: null, pin_must_change: false, version: nextVersion });
    tx.create(memberSessionRef(freshToken), { owner_id: owner, member_id: member, version: nextVersion, expires_at: new Date(Date.now() + 7 * 86400_000).toISOString() });
    return 200;
  });
}
