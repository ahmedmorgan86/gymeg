import {test, beforeEach, after} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {readFile} from 'node:fs/promises';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { url: 'data:text/javascript,export{}', shortCircuit: true };
    try { return next(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context);
      throw error;
    }
  },
  load(url, context, next) {
    if (url.endsWith('/app/lib/database.ts')) return { format: 'module', shortCircuit: true, source: `
      export const getPool=()=>({
        query:async(sql,params)=>{globalThis.__cronQueries.push({sql,params});return {rows:[{valid:globalThis.__cronDbValid===true}]};},
        connect:async()=>({query:async()=>({rows:[]}),release(){}})
      });
      export const withScope=async(_owner,fn)=>fn({query:async()=>({rows:[]})});
    ` };
    if (url.endsWith('/app/lib/server-workspace.ts')) return { format: 'module', shortCircuit: true, source: 'export const reply=(data,status=200)=>Response.json(data,{status});export const readSpace=async()=>({state:{}});' };
    if (url.endsWith('/app/lib/whatsapp-server.ts')) return { format: 'module', shortCircuit: true, source: 'export const runWhatsApp=async()=>({sent:0});' };
    return next(url, context);
  }
});

const {GET} = await import('../app/api/cron/whatsapp/route.ts');

const previousSecret = process.env.CRON_SECRET;
after(() => {
  if (previousSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previousSecret;
});

beforeEach(() => {
  process.env.CRON_SECRET = 'vercel-cron-secret-0123456789';
  globalThis.__cronQueries = [];
  globalThis.__cronDbValid = false;
});

function cronRequest(token) {
  const headers = token === undefined ? {} : {authorization: `Bearer ${token}`};
  return new Request('https://gym.example/api/cron/whatsapp', {headers});
}

test('B07: Vercel cron is registered for the WhatsApp worker on a Hobby-compatible daily schedule', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  const entry = config.crons?.find(cron => cron.path === '/api/cron/whatsapp');
  assert.ok(entry, 'vercel.json must schedule /api/cron/whatsapp');
  // Vercel Hobby allows one run per day only; a */N expression fails deployment.
  assert.match(entry.schedule, /^\d{1,2} \d{1,2} \* \* \*$/);
});

test('B07: unauthenticated and wrong-secret cron calls are rejected without a DB lookup', async () => {
  for (const request of [cronRequest(undefined), cronRequest('wrong-secret-value-1234567890')]) {
    const response = await GET(request);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {error: 'forbidden'});
  }
  assert.equal(globalThis.__cronQueries.length, 0);
});

test('B07: the configured CRON_SECRET authorizes the Vercel invocation', async () => {
  const response = await GET(cronRequest('vercel-cron-secret-0123456789'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {sent: 0});
});

test('B07: the legacy Vault-validated token still authorizes the disabled pg_cron path', async () => {
  globalThis.__cronDbValid = true;
  const response = await GET(cronRequest('a'.repeat(64)));
  assert.equal(response.status, 200);
  assert.equal(globalThis.__cronQueries.length, 1);
});

test('B07: cron handler never logs the shared secret', async () => {
  const source = await readFile(new URL('../app/api/cron/whatsapp/route.ts', import.meta.url), 'utf8');
  assert.match(source, /CRON_SECRET/);
  assert.doesNotMatch(source, /console\.(log|info|warn|error)/);
});
