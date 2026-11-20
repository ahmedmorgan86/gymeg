import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { randomBytes } from 'node:crypto';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { url: 'data:text/javascript,export{}', shortCircuit: true };
    try { return next(specifier, context); }
    catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context); throw error; }
  },
  load(url, context, next) {
    if (url.endsWith('/app/lib/firestore-db.ts')) return { format: 'module', shortCircuit: true, source: `export const getFirestoreDb=()=>({collection:()=>({doc:()=>({set:async value=>{globalThis.__whatsappStored=value}})})});` };
    if (url.endsWith('/app/lib/firebase-member-auth.ts')) return { format: 'module', shortCircuit: true, source: 'export const firebaseMemberLicense=async()=>null;' };
    if (url.endsWith('/app/lib/server-workspace.ts')) return { format: 'module', shortCircuit: true, source: 'export const readSpace=async()=>({state:{}});' };
    if (url.endsWith('/app/lib/commercial.ts')) return { format: 'module', shortCircuit: true, source: 'export const normalizeLicense=x=>x;' };
    return next(url, context);
  }
});

const { connectWhatsApp, whatsappEncryptionReady } = await import('../app/lib/firestore-whatsapp.ts');
const previous = process.env.GYMEG_WHATSAPP_TOKEN_KEY;
after(() => { if (previous === undefined) delete process.env.GYMEG_WHATSAPP_TOKEN_KEY; else process.env.GYMEG_WHATSAPP_TOKEN_KEY = previous; });

test('WhatsApp connection fails closed without a valid encryption key', async () => {
  delete process.env.GYMEG_WHATSAPP_TOKEN_KEY;
  assert.equal(whatsappEncryptionReady(), false);
  await assert.rejects(connectWhatsApp('club', 'branch', '1234567890', 'v21.0', 'private-token'));
  process.env.GYMEG_WHATSAPP_TOKEN_KEY = 'invalid';
  assert.equal(whatsappEncryptionReady(), false);
});

test('Firestore WhatsApp connection stores authenticated ciphertext, never the provider token', async () => {
  process.env.GYMEG_WHATSAPP_TOKEN_KEY = randomBytes(32).toString('base64');
  assert.equal(whatsappEncryptionReady(), true);
  await connectWhatsApp('club', 'branch', '1234567890', 'v21.0', 'private-provider-token');
  assert.equal(globalThis.__whatsappStored.owner_id, 'club');
  assert.equal(globalThis.__whatsappStored.branch, 'branch');
  assert.equal(globalThis.__whatsappStored.token_cipher.split('.').length, 3);
  assert.doesNotMatch(JSON.stringify(globalThis.__whatsappStored), /private-provider-token/);
});
