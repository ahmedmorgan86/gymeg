import { createHash } from 'node:crypto';
import { getFirestoreDb } from './firestore-db.ts';
import { endpointDigest, encryptPushSubscription } from './push-crypto';

export async function setWebPushSubscription(owner: string, branch: string, type: 'staff' | 'member', recipient: string, subscription: { endpoint: string; keys: { p256dh: string; auth: string }; expirationTime?: number | null }, subscribe: boolean) {
  const digest = endpointDigest(subscription.endpoint);
  const id = createHash('sha256').update([owner, branch, type, recipient, digest].join('\0')).digest('hex');
  const ref = getFirestoreDb().collection('push_subscriptions').doc(id);
  if (subscribe) await ref.set({ owner_id: owner, branch, recipient_type: type, recipient_id: recipient, endpoint_hash: digest, subscription_ciphertext: encryptPushSubscription({ ...subscription, expirationTime: subscription.expirationTime ?? null }), created_at: new Date().toISOString() });
  else await ref.delete();
}

export async function eligibleWebPushSubscriptions(owner: string, branch: string, type: 'staff' | 'member', recipient: string | null) {
  const db = getFirestoreDb();
  const docs = await db.collection('push_subscriptions').where('owner_id', '==', owner).where('branch', '==', branch).where('recipient_type', '==', type).limit(251).get();
  if (docs.size > 250) throw Error('Web push subscription capacity exceeded');
  const allowed = [];
  for (const doc of docs.docs) {
    const value = doc.data();
    if (recipient && value.recipient_id !== recipient) continue;
    if (type === 'staff' && value.recipient_id !== owner) {
      const tenant = owner.startsWith('tenant:') ? owner.slice(7) : null;
      const accessDoc = tenant ? await db.collection('tenant_memberships').doc(`${tenant}_${value.recipient_id}`).get() : await db.collection('gym_access').doc(`${owner}_${value.recipient_id}`).get();
      const access = accessDoc.data();
      if (!access || access.revoked !== false || !['owner', 'manager'].includes(access.role) || Array.isArray(access.branches) && !access.branches.includes(branch)) continue;
    }
    allowed.push({ ref: doc.ref, subscription_ciphertext: value.subscription_ciphertext as string });
  }
  return allowed;
}
