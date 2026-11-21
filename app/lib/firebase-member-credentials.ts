import { getFirestoreDb } from './firestore-db.ts';
import { memberAccessRef, memberCredentialFor, protectPin, revealPin } from './firebase-member-auth';
import { newMemberPin, normalizeMemberPhone, normalizeMemberPin, isSharedLegacyPin } from './member-phone';

export async function firebaseMemberCredentials(owner: string, actor: string, member: { id: string; branch: string; phone: string }, action: string, supplied: unknown) {
  const db = getFirestoreDb(), ref = memberAccessRef(owner, member.id), phone = normalizeMemberPhone(member.phone);
  const portal = db.collection('member_portal_access').doc(ref.id);
  return db.runTransaction(async tx => {
    const [snapshot, portalDoc] = await Promise.all([tx.get(ref), action === 'revoke' ? tx.get(portal) : Promise.resolve(null)]);
    let existing = snapshot.data();
    if (!existing) {
      const initial = memberCredentialFor(member, newMemberPin());
      existing = { owner_id: owner, ...initial };
    }
    const write = (fields: Record<string, unknown>) => snapshot.exists ? tx.update(ref, fields) : tx.create(ref, { ...existing, ...fields });
    const result = (value: Record<string, unknown>, event?: string) => {
      if (event) tx.create(db.collection('gym_access_events').doc(), { owner_id: owner, actor, target: member.id, action: event, at: new Date().toISOString(), details: { branch: member.branch } });
      return value;
    };
    if (action === 'revoke') {
      write({ revoked: true, version: existing.version + 1 });
      if (portalDoc?.exists) tx.update(portal, { revoked: true, invite_hash: null });
      return result({ revoked: true }, 'member.pin.revoke');
    }
    if (action === 'requireChange') {
      if (!phone) return { needsPhone: true };
      if (existing.revoked || existing.inactive) return { revoked: true };
      write({ pin_must_change: true, version: existing.version + 1 });
      return result({ phone, changeRequired: true, revoked: false }, 'member.pin.requireChange');
    }
    if (action === 'setPin' || action === 'rotate') {
      if (!phone) return { phone: null, pin: null, needsPhone: true };
      const custom = supplied ? normalizeMemberPin(supplied) : null;
      if (action === 'setPin' && !custom || supplied && (!custom || isSharedLegacyPin(custom))) return { invalidPin: true };
      const previous = existing.pin_cipher ? revealPin(existing.pin_cipher) : null;
      const pin = custom || newMemberPin(previous);
      write({ ...protectPin(pin), pin_must_change: true, version: existing.version + 1, revoked: false, inactive: false });
      return result({ phone, pin, revoked: false, needsPhone: false, changeRequired: true }, action === 'setPin' ? 'member.pin.set' : 'member.pin.reset');
    }
    if (!snapshot.exists) tx.create(ref, existing);
    return { phone, pin: existing.revoked ? null : revealPin(existing.pin_cipher), revoked: existing.revoked, needsPhone: !phone, pinChanged: !existing.pin_must_change, changeRequired: !existing.revoked && existing.pin_must_change && !existing.pin_cipher };
  });
}
