import { randomBytes } from 'node:crypto';
import { getFirestoreDb } from './firestore-db.ts';
import { firebaseMemberLicense, memberSessionRef, phoneDigest, pinMatches, recordMemberAttempt, registerMemberSession } from './firebase-member-auth';
import { normalizeMemberPhone } from './member-phone';
import { licenseState, type License } from './licensing';
import { readSpace } from './server-workspace';

export async function firebaseMemberLogin(phone: string, pin: string, ip: string, selected: string) {
  const phoneHash = phoneDigest(phone);
  if (!await recordMemberAttempt('phone-ip:' + ip, 20) || !await recordMemberAttempt('phone:' + phoneHash, 5)) return { error: 'rateLimit' as const };
  const snapshot = await getFirestoreDb().collection('member_code_access').where('phone_hash', '==', phoneHash).limit(21).get();
  if (snapshot.size > 20) return { error: 'invalidCredentials' as const };
  const valid: { owner_id: string; member_id: string; branch: string; version: number; pin_must_change: boolean; key: string; clubName: string; branchName: string }[] = [];
  for (const doc of snapshot.docs) {
    const account = doc.data();
    if (account.revoked || account.inactive || !pinMatches(pin, account)) continue;
    const { state } = await readSpace(account.owner_id);
    if (!state.members.some(m => m.id === account.member_id && m.branch === account.branch && !m.demo && !m.archived && normalizeMemberPhone(m.phone) === phone)) continue;
    const license = await firebaseMemberLicense(account.owner_id);
    if (license && !licenseState(license as License).writable) continue;
    valid.push({ owner_id: account.owner_id, member_id: account.member_id, branch: account.branch, version: account.version, pin_must_change: account.pin_must_change, key: account.owner_id + '|' + account.member_id, clubName: state.settings.name, branchName: state.branches.find(b => b.id === account.branch)?.name ?? account.branch });
  }
  if (!valid.length) return { error: 'invalidCredentials' as const };
  if (new Set(valid.map(a => a.owner_id)).size > 1 && !selected) return { chooseAccount: valid.map(a => ({ id: a.key, name: a.clubName, branch: a.branchName })) };
  const account = selected ? valid.find(a => a.key === selected) : valid.length === 1 ? valid[0] : undefined;
  if (!account) return { error: 'invalidCredentials' as const };
  const token = randomBytes(32).toString('hex');
  await registerMemberSession(token, account.owner_id, account.member_id, account.version);
  return { token };
}

export async function firebaseMemberLogout(token: string) {
  const ref = memberSessionRef(token);
  const doc = await ref.get();
  if (doc.exists) await ref.delete();
}
