import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

// Mixed-mode behavior: Firebase envs present (FCM push) while the persistence
// backend is Postgres. Platform-admin authorization must consult Postgres
// (commercialTransaction) and never Firestore (firebasePlatform).
let mode = { firebaseConfigured: true, firestorePersistence: false };
let firestoreCalls = 0, postgresCalls = 0;
registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context);
      throw error;
    }
  },
  load(url, context, next) {
    if (url.endsWith('/app/lib/firestore-db.ts')) return { format: 'module', shortCircuit: true, source: 'export const isFirebaseConfigured=()=>globalThis.__mode.firebaseConfigured;export const isFirestorePersistence=()=>globalThis.__mode.firestorePersistence;' };
    if (url.endsWith('/app/lib/firestore-commercial.ts')) return { format: 'module', shortCircuit: true, source: 'export const firebasePlatform=async()=>{globalThis.__calls.firestore++;return true;};' };
    if (url.endsWith('/app/lib/commercial.ts')) return { format: 'module', shortCircuit: true, source: 'export const commercialTransaction=async(_user,fn)=>{globalThis.__calls.postgres++;return fn(null,true);};' };
    return next(url, context);
  },
});

const user = { userId: 'admin', email: 'admin@example.invalid', displayName: 'Admin', fullName: 'Admin' };

test('mixed mode (Firebase push envs + Postgres data) authorizes platform admins against Postgres only', async () => {
  globalThis.__mode = { firebaseConfigured: true, firestorePersistence: false };
  globalThis.__calls = { firestore: 0, postgres: 0 };
  const { platformAuthority } = await import('../app/lib/platform-authority.ts');
  assert.equal(await platformAuthority(user), true);
  assert.deepEqual(globalThis.__calls, { firestore: 0, postgres: 1 });
});

test('legacy mode (Firestore persistence) authorizes platform admins against Firestore', async () => {
  globalThis.__mode = { firebaseConfigured: true, firestorePersistence: true };
  globalThis.__calls = { firestore: 0, postgres: 0 };
  const { platformAuthority } = await import('../app/lib/platform-authority.ts');
  assert.equal(await platformAuthority(user), true);
  assert.deepEqual(globalThis.__calls, { firestore: 1, postgres: 0 });
});
