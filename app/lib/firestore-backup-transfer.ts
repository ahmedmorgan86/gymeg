import { randomUUID } from 'node:crypto';
import { getFirestoreDb } from './firestore-db.ts';
import { BACKUP_CHUNK_BYTES, TransferError, assembleTransfer, backupDigest, decodeChunk, transferSpec } from './backup-transfer.ts';

const validId = (id: unknown) => typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id);
const scoped = async (owner: string, actor: string, id: unknown, mode: 'upload' | 'download') => {
  if (!validId(id)) throw new TransferError('invalid');
  const ref = getFirestoreDb().collection('gym_backup_transfers').doc(id as string);
  const doc = await ref.get(), value = doc.data();
  if (!value || value.owner_id !== owner || value.actor_id !== actor || value.mode !== mode || Date.parse(value.expires_at) <= Date.now()) throw new TransferError('notFound', 404);
  return { ref, value };
};
export async function firebaseStartTransfer(owner: string, actor: string, mode: 'upload' | 'download', bytes: number, digest: string, content?: Buffer) {
  const spec = transferSpec(bytes, digest);
  if (content && (content.length !== bytes || backupDigest(content) !== digest)) throw new TransferError('digestMismatch');
  const db = getFirestoreDb(), id = randomUUID(), ref = db.collection('gym_backup_transfers').doc(id);
  const expires_at = new Date(Date.now() + 30 * 60_000).toISOString();
  const batch = db.batch();
  batch.create(ref, { owner_id: owner, actor_id: actor, mode, bytes, digest, expires_at });
  if (content) for (let i = 0; i < spec.parts; i++) batch.create(ref.collection('chunks').doc(String(i)), { data: content.subarray(i * BACKUP_CHUNK_BYTES, (i + 1) * BACKUP_CHUNK_BYTES).toString('base64') });
  await batch.commit();
  return { id, ...spec, chunkBytes: BACKUP_CHUNK_BYTES };
}
export async function firebasePutChunk(owner: string, actor: string, id: unknown, index: unknown, data: unknown) {
  if (!Number.isSafeInteger(index) || Number(index) < 0) throw new TransferError('invalid');
  const chunk = decodeChunk(data), { ref, value } = await scoped(owner, actor, id, 'upload');
  if (Number(index) >= Math.ceil(value.bytes / BACKUP_CHUNK_BYTES) || chunk.length !== Math.min(BACKUP_CHUNK_BYTES, value.bytes - Number(index) * BACKUP_CHUNK_BYTES)) throw new TransferError('invalidChunk');
  await getFirestoreDb().runTransaction(async tx => {
    const part = ref.collection('chunks').doc(String(index)), existing = await tx.get(part);
    if (existing.exists && existing.data()?.data !== data) throw new TransferError('chunkMismatch', 409);
    if (!existing.exists) tx.create(part, { data });
  });
  return { ok: true };
}
export async function firebaseTransferContent(owner: string, actor: string, id: unknown) {
  const { ref, value } = await scoped(owner, actor, id, 'upload');
  const chunks: Record<string, string> = {};
  for (let i = 0; i < Math.ceil(value.bytes / BACKUP_CHUNK_BYTES); i++) {
    const part = await ref.collection('chunks').doc(String(i)).get();
    if (!part.exists) throw new TransferError('invalidChunk');
    chunks[String(i)] = part.data()!.data;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(assembleTransfer({ bytes: value.bytes, digest: value.digest, chunks }));
}
export async function firebaseGetChunk(owner: string, actor: string, id: unknown, index: unknown) {
  if (!Number.isSafeInteger(index) || Number(index) < 0) throw new TransferError('invalid');
  const { ref, value } = await scoped(owner, actor, id, 'download');
  if (Number(index) >= Math.ceil(value.bytes / BACKUP_CHUNK_BYTES)) throw new TransferError('notFound', 404);
  const part = await ref.collection('chunks').doc(String(index)).get();
  if (!part.exists) throw new TransferError('notFound', 404);
  return { data: part.data()!.data as string };
}
export async function firebaseDiscardTransfer(owner: string, actor: string, id: unknown) {
  if (!validId(id)) throw new TransferError('invalid');
  const ref = getFirestoreDb().collection('gym_backup_transfers').doc(id as string);
  const doc = await ref.get();
  if (doc.exists && doc.data()?.owner_id === owner && doc.data()?.actor_id === actor) await getFirestoreDb().recursiveDelete(ref);
}
