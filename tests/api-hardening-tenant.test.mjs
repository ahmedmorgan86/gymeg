import {test, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

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
    const module = (source) => ({ format: 'module', shortCircuit: true, source });
    if (url.endsWith('/app/lib/server-workspace.ts')) return module(`
      export const reply=(data,status=200)=>Response.json(data,{status});
      export const sameOrigin=request=>request.headers.get('origin')===new URL(request.url).origin;
      export const context=async()=>globalThis.__hardeningContext;
      export const readSpace=async()=>({state:{members:[{id:'m1',branch:'main',archived:false,demo:false}],branches:[{id:'main'}]},revision:0});
      export const packet=()=>({ok:true});
      export const hash=async value=>value;
      export const administrator=async()=>true;
    `);
    if (url.endsWith('/app/lib/licensing.ts')) return module(`
      export class CommercialError extends Error {constructor(code,status=409){super(code);this.code=code;this.status=status;}}
      export const licenseState=()=>({writable:true});
    `);
    if (url.endsWith('/app/lib/database.ts')) return module(`
      export const getPool=()=>{throw new Error('unexpected database access');};
      export const withScope=async()=>{throw new Error('unexpected database access');};
    `);
    if (url.endsWith('/app/lib/entity-store.ts')) return module('export const persistSpace=async()=>true;');
    if (url.endsWith('/app/lib/domain.ts')) return module('export class RuleError extends Error {} export const applyOperation=()=>({});');
    if (url.endsWith('/app/lib/access.ts')) return module('export const receptionPermitted=()=>true;');
    if (url.endsWith('/app/lib/workspace-error.ts')) return module('export const workspaceUniqueError=()=>null;');
    if (url.endsWith('/app/lib/web-push.ts')) return module('export const sendCommunityPush=async()=>{};');
    if (url.endsWith('/app/lib/member-console.ts')) return module('export const fullName=value=>value;export const memberPhone=value=>value;');
    if (url.endsWith('/app/lib/attendance-presence.ts')) return module('export const currentAttendance=()=>[];');
    if (url.endsWith('/app/lib/member-code-session.ts')) return module('export const codeMemberIdentity=async()=>null;');
    if (url.endsWith('/app/lib/member-code.ts')) return module('export const memberSessionToken=()=>null;');
    if (url.endsWith('/app/chatgpt-auth.ts')) return module('export const getChatGPTUser=async()=>({userId:"qa-user",email:"qa@example.test"});');
    if (url.endsWith('/app/lib/commercial.ts')) return module('export const normalizeLicense=value=>value;export const commercialEnabled=()=>true;');
    if (url.endsWith('/app/lib/member-view.ts')) return module('export const memberView=()=>({});');
    return next(url, context);
  }
});

const {GET: workspaceGet} = await import('../app/api/workspace/route.ts');
const {GET: presenceGet} = await import('../app/api/presence/route.ts');
const {GET: photoGet} = await import('../app/api/member-photo/route.ts');
const {GET: portalGet} = await import('../app/api/member-portal/route.ts');

beforeEach(() => {
  globalThis.__hardeningContext = {
    role: 'owner', branches: null, owner: 'qa-owner', tenantId: 'tenant-a',
    license: {status: 'active'}, user: {userId: 'qa-user', displayName: 'QA owner', email: 'qa@example.test'}
  };
});

function getRequest(path, tenant = 'tenant-b') {
  const headers = {origin: 'https://gym.example'};
  if (tenant !== null) headers['x-gymos-tenant'] = tenant;
  return new Request('https://gym.example' + path, {headers});
}

test('B14: a stale header from another club is rejected on every sensitive read', async () => {
  const cases = [
    ['workspace', workspaceGet, '/api/workspace'],
    ['presence', presenceGet, '/api/presence?branch=main'],
    ['member-photo', photoGet, '/api/member-photo?owner=tenant-a&id=m1'],
    ['member-portal', portalGet, '/api/member-portal?member=m1&club=tenant-a']
  ];
  for (const [name, handler, path] of cases) {
    const response = await handler(getRequest(path));
    assert.equal(response.status, 409, `${name} must reject a foreign tenant header`);
    assert.deepEqual(await response.json(), {error: 'clubChanged'});
  }
});

test('B14: initial workspace read without tenant header succeeds for authenticated user', async () => {
  const response = await workspaceGet(getRequest('/api/workspace', null));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {ok: true});
});

test('B14: non-commercial mode still permits a stale header without blocking reads', async () => {
  globalThis.__hardeningContext = {...globalThis.__hardeningContext, license: null};
  const response = await workspaceGet(getRequest('/api/workspace'));
  assert.equal(response.status, 200);
});
