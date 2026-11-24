import { createHash } from 'node:crypto';
import { getFirestoreDb } from './firestore-db.ts';
import { encryptFcmToken, fcmTokenDigest } from './push-crypto';

const id = (...parts: string[]) => createHash('sha256').update(parts.join('\0')).digest('hex');
export async function setFcmSubscription(owner: string, branch: string, type: 'staff' | 'member', recipient: string, token: string, register: boolean) {
  const digest = fcmTokenDigest(token), ref = getFirestoreDb().collection('fcm_subscriptions').doc(id(owner, branch, type, recipient, digest));
  if (register) await ref.set({ owner_id: owner, branch, recipient_type: type, recipient_id: recipient, token_hash: digest, token_ciphertext: encryptFcmToken(token), created_at: new Date().toISOString() });
  else await ref.delete();
}
export async function setSupportFcm(user: string, token: string, register: boolean) {
  const digest = fcmTokenDigest(token), ref = getFirestoreDb().collection('support_fcm_subscriptions').doc(id(user, digest));
  if (register) await ref.set({ user_id: user, token_hash: digest, token_ciphertext: encryptFcmToken(token), created_at: new Date().toISOString() });
  else await ref.delete();
}
export async function eligibleFcmSubscriptions(owner: string, branch: string, type: 'staff' | 'member', recipient: string | null) {
  const docs = await getFirestoreDb().collection('fcm_subscriptions').where('owner_id', '==', owner).where('branch', '==', branch).where('recipient_type', '==', type).limit(251).get();
  if (docs.size > 250) throw Error('FCM subscription capacity exceeded');
  const allowed = [];
  for (const doc of docs.docs) {
    const value = doc.data();
    if (recipient && value.recipient_id !== recipient) continue;
    if (type === 'staff') {
      if (value.recipient_id !== owner) {
        const tenant = owner.startsWith('tenant:') ? owner.slice(7) : null;
        const member = tenant ? await getFirestoreDb().collection('tenant_memberships').doc(`${tenant}_${value.recipient_id}`).get() : await getFirestoreDb().collection('gym_access').doc(`${owner}_${value.recipient_id}`).get();
        const access = member.data();
        if (!access || access.revoked !== false || !['owner', 'manager'].includes(access.role) || Array.isArray(access.branches) && !access.branches.includes(branch)) continue;
      }
    }
    allowed.push({ ref: doc.ref, token_ciphertext: value.token_ciphertext as string });
  }
  return allowed;
}
