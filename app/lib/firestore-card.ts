import 'server-only';
import { createHash } from 'node:crypto';
import { getFirestoreDb } from './firestore-db.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const cardRef = (owner: string, code: string) => getFirestoreDb().collection('membership_cards').doc(digest(owner + '\0' + code));
const pendingRef = (owner: string, member: string, branch: string) => getFirestoreDb().collection('card_reservations').doc(digest(owner + '\0' + member + '\0' + branch));

export async function reserveFirestoreCard(owner: string, member: string, branch: string, day: string, requested?: string): Promise<string | null> {
  const date = day.replaceAll('-', '');
  if (!/^\d{8}$/.test(date)) throw Error('Invalid card date');
  const db = getFirestoreDb(), pending = pendingRef(owner, member, branch);
  if (requested) {
    const card = cardRef(owner, requested);
    return db.runTransaction(async tx => {
      const existing = await tx.get(card);
      if (existing.exists) return existing.data()?.owner_id === owner && existing.data()?.member_id === member && existing.data()?.branch === branch && existing.data()?.status === 'reserved' ? requested : null;
      tx.create(card, { code: requested, owner_id: owner, member_id: member, branch, status: 'reserved', created_at: new Date().toISOString() });
      return requested;
    });
  }
  const counter = db.collection('card_number_counters').doc(date);
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await db.runTransaction(async tx => {
      const [previous, counterDoc] = await Promise.all([tx.get(pending), tx.get(counter)]);
      if (previous.exists) return previous.data()?.code as string;
      const next = (counterDoc.data()?.value ?? 0) + 1;
      const code = `${date}-${String(next).padStart(4, '0')}`, card = cardRef(owner, code);
      const existing = await tx.get(card);
      tx.set(counter, { day: date, value: next });
      if (existing.exists) return null;
      tx.create(card, { code, owner_id: owner, member_id: member, branch, status: 'reserved', created_at: new Date().toISOString() });
      tx.create(pending, { owner_id: owner, member_id: member, branch, code });
      return code;
    });
    if (value) return value;
  }
  throw Error('Daily card range busy');
}
