import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { registerHooks } from 'node:module';

const rows = new Map();
const db = {
  collection(name) {
    return {
      doc(id) { const path = `${name}/${id}`; return { id, path, async get() { return { exists: rows.has(path), data: () => rows.get(path) }; }, async create(data) { if (rows.has(path)) throw Error('exists'); rows.set(path, data); }, async delete() { rows.delete(path); } }; },
      where(field, op, value) { return { limit(max) { return { async get() { const docs = [...rows].filter(([path, data]) => path.startsWith(name + '/') && data[field] === value).slice(0, max).map(([path, data]) => ({ data: () => data, ref: { path } })); return { docs, size: docs.length }; } }; } }; },
    };
  },
  async runTransaction(work) {
    const writes = [];
    const tx = {
      async get(ref) { return { exists: rows.has(ref.path), data: () => rows.get(ref.path) }; },
      set(ref, data) { writes.push(() => rows.set(ref.path, data)); },
      create(ref, data) { writes.push(() => { if (rows.has(ref.path)) throw Error('exists'); rows.set(ref.path, data); }); },
      update(ref, data) { writes.push(() => rows.set(ref.path, { ...rows.get(ref.path), ...data })); },
    };
    const result = await work(tx);
    for (const write of writes) write();
    return result;
  },
};
globalThis.__firebaseMemberTestDb = db;
registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context); }
    catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context); throw error; }
  },
  load(url, context, next) {
    if (url.endsWith('/app/lib/firestore-db.ts')) return { format: 'module', shortCircuit: true, source: 'export const getFirestoreDb=()=>globalThis.__firebaseMemberTestDb;' };
    if (url.endsWith('/app/lib/server-workspace.ts')) return { format: 'module', shortCircuit: true, source: 'export const readSpace=async()=>({state:{members:[{id:"member-1",branch:"main",phone:"+201000000000",demo:false,archived:false}],settings:{name:"Test Gym"},branches:[{id:"main",name:"Main"}]}});' };
    return next(url, context);
  },
});
const { memberAccessRef, memberCredentialFor, firebaseMemberIdentity, firebaseChangeMemberPin } = await import('../app/lib/firebase-member-auth.ts');
const { firebaseMemberLogin } = await import('../app/lib/firebase-member-session.ts');
const { memberSessionRef } = await import('../app/lib/firebase-member-auth.ts');
const oldKey = process.env.GYMEG_MEMBER_PIN_KEY;
process.env.GYMEG_MEMBER_PIN_KEY = randomBytes(32).toString('base64');

test('Member login verifies PIN and changing PIN revokes old sessions', async () => {
  const owner = 'tenant:test-gym', member = 'member-1';
  await memberAccessRef(owner, member).create({ owner_id: owner, ...memberCredentialFor({ id: member, branch: 'main', phone: '+201000000000' }, '748392') });
  assert.equal((await firebaseMemberLogin('+201000000000', '748391', 'test-ip', '')).error, 'invalidCredentials');
  const signed = await firebaseMemberLogin('+201000000000', '748392', 'test-ip', '');
  assert.ok(signed.token);
  assert.equal((await firebaseMemberIdentity(signed.token)).member_id, member);
  const fresh = randomBytes(32).toString('hex');
  assert.equal(await firebaseChangeMemberPin(owner, member, 1, '748392', '481729', signed.token, fresh), 200);
  assert.equal(await firebaseMemberIdentity(signed.token), null);
  assert.equal((await firebaseMemberIdentity(fresh)).pin_must_change, false);
  assert.equal((await firebaseMemberLogin('+201000000000', '748392', 'different-ip', '')).error, 'invalidCredentials');
  assert.ok((await firebaseMemberLogin('+201000000000', '481729', 'different-ip', '')).token);
  assert.equal((await memberSessionRef(fresh).get()).exists, true);
});
process.on('exit', () => { if (oldKey === undefined) delete process.env.GYMEG_MEMBER_PIN_KEY; else process.env.GYMEG_MEMBER_PIN_KEY = oldKey; });
