import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

// Local module mocks: no Supabase or PostgreSQL is contacted by these routes.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'server-only') return { url: 'data:text/javascript,export{}', shortCircuit: true };
    if (specifier === 'next/server') return { url: 'data:text/javascript,export function after(){}', shortCircuit: true };
    try { return next(specifier, context); }
    catch (error) {
      if (error.code === 'ERR_MODULE_NOT_FOUND' && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(specifier + '.ts', context);
      throw error;
    }
  },
  load(url, context, next) {
    if (url.endsWith('/app/lib/server-workspace.ts')) return { format: 'module', shortCircuit: true, source: `
      export const reply=(data,status=200)=>Response.json(data,{status});
      export const sameOrigin=request=>request.headers.get('origin')===new URL(request.url).origin;
      export const context=async()=>globalThis.__hardeningContext;
      export const readSpace=async()=>({state:{members:[{id:'m1',branch:'main',archived:false,demo:false}],branches:[]},revision:0});
    ` };
    if (url.endsWith('/app/lib/licensing.ts')) return { format: 'module', shortCircuit: true, source: `
      export class CommercialError extends Error {constructor(code,status=409){super(code);this.code=code;this.status=status;}}
      export const licenseState=()=>({writable:true});
    ` };
    if (url.endsWith('/app/lib/database.ts')) return { format: 'module', shortCircuit: true, source: `
      export const getPool=()=>{throw new Error('unexpected DB');};
      export const withScope=async(_owner,fn)=>fn({query:async()=>({rows:[]})});
    ` };
    if (url.endsWith('/app/lib/member-code-session.ts')) return { format: 'module', shortCircuit: true, source: 'export const codeMemberIdentity=async()=>null;' };
    if (url.endsWith('/app/lib/member-code.ts')) return { format: 'module', shortCircuit: true, source: 'export const memberSessionToken=()=>null;' };
    if (url.endsWith('/app/chatgpt-auth.ts')) return { format: 'module', shortCircuit: true, source: 'export const getChatGPTUser=async()=>globalThis.__hardeningUser??null;' };
    if (url.endsWith('/app/lib/member-view.ts')) return { format: 'module', shortCircuit: true, source: 'export const memberView=()=>({});' };
    if (url.endsWith('/app/lib/commercial.ts')) return { format: 'module', shortCircuit: true, source: 'export const normalizeLicense=value=>value;export const commercialEnabled=()=>false;' };
    return next(url, context);
  }
});

const {POST: memberAccessPost} = await import('../app/api/member-access/route.ts');
const {POST: memberPortalPost} = await import('../app/api/member-portal/route.ts');

function setup() {
  globalThis.__hardeningContext = {
    role: 'owner', branches: null, owner: 'qa-owner', tenantId: 'qa-tenant', license: null,
    user: {userId: 'qa-user', displayName: 'QA owner'}
  };
  globalThis.__hardeningUser = {userId: 'qa-user', email: 'qa@example.test'};
}
function request(path, body) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request('https://gym.example' + path, {
    method: 'POST',
    headers: {origin: 'https://gym.example', 'content-type': 'application/json'},
    body: payload
  });
}

test('A10: member-access rejects oversized bodies with 413 before parsing JSON', async () => {
  setup();
  const response = await memberAccessPost(request('/api/member-access', {member: 'm1', email: 'a@b.co', pad: 'x'.repeat(9000)}));
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {error: 'limit'});
});

test('A10: member-access rejects non-object JSON bodies with 400', async () => {
  setup();
  for (const body of ['[]', '"text"', 'null', '42']) {
    const response = await memberAccessPost(request('/api/member-access', body));
    assert.equal(response.status, 400, body);
  }
});

test('A10: member-access still accepts a bounded, well-formed body', async () => {
  setup();
  const response = await memberAccessPost(request('/api/member-access', {member: 'm1', action: 'revoke'}));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {ok: true});
});

test('A10: member-portal rejects oversized invite bodies with 413 and non-object JSON with 400', async () => {
  setup();
  const oversized = await memberPortalPost(request('/api/member-portal', {invite: 'a'.repeat(9000)}));
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), {error: 'limit'});
  for (const body of ['[]', JSON.stringify('a'.repeat(64)), 'null']) {
    const response = await memberPortalPost(request('/api/member-portal', body));
    assert.equal(response.status, 400, body);
  }
});
