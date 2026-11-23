import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {registerHooks} from 'node:module';registerHooks({load(url,c,n){const loaded=n(url,c);if(url.endsWith('/app/lib/server-workspace.ts')&&typeof loaded.source==='string')loaded.source=loaded.source.replace('readSpace=async()=>structuredClone(globalThis.__qaSpace)','readSpace=async()=> (globalThis.__reviewReadHook?.(),structuredClone(globalThis.__qaSpace))');return loaded;}});const {POST}=await import('../app/api/backup/route.ts');
import {emptyState, applyOperation} from '../app/lib/domain.ts';
import {randomUUID} from 'node:crypto';
// Synthetic fixtures only. REAL /api/backup v2 restore route with the in-memory harness of backup-api.integration.mjs.
const webp = 'data:image/webp;base64,' + (await sharp({create: {width: 320, height: 320, channels: 3, background: '#468'}}).webp({quality: 80}).toBuffer()).toString('base64');
const fake = () => { const b = Buffer.alloc(30); b.write('RIFF', 0); b.writeUInt32LE(22, 4); b.write('WEBPVP8 ', 8); b.writeUInt32LE(10, 16); return 'data:image/webp;base64,' + b.toString('base64'); };
function setup() {
  globalThis.__qaSpace = {state: emptyState(), revision: 0};
  globalThis.__qaContext = {role: 'owner', branches: null, owner: 'qa-owner', tenantId: 'qa-tenant', license: null, user: {userId: 'qa-user', displayName: 'QA owner', email: 'qa@example.invalid'}};
}
// Members come from the app's own member.save (valid by construction); the photo is then set directly on the stored row.
const members = (state, photos) => { let st = state; photos.forEach((p, i) => { st = applyOperation(st, {type: 'member.save', branch: 'main', name: 'Member ' + (i + 1), phone: '0100000000' + i, joined: '2026-10-01', expires: '2026-12-01'}, '2026-11-22T10:00:00Z', 'T', randomUUID); st.members.at(-1).photo = p; }); return st; };
function restore(build) {
  const state = build(emptyState());
  const backup = {format: 'gymos-backup', version: 2, tenant: 'qa-tenant', createdAt: new Date().toISOString(), revision: 0, digest: createHash('sha256').update(JSON.stringify(state)).digest('hex'), state};
  return POST(new Request('https://gym.example/api/backup', {method: 'POST', headers: {origin: 'https://gym.example', 'Content-Type': 'application/json'}, body: JSON.stringify({action: 'restore', confirm: 'RESTORE', revision: globalThis.__qaSpace.revision, backup})}));
}
test('REAL v2 restore route: flag ON admits real WebP slots, rejects fakes, accepts text that only looks like the prefix; flag OFF rejects WebP', async () => {
  try {
    process.env.NEXT_PUBLIC_PHOTO_WEBP = '1';
    setup(); assert.equal((await restore((s) => members(s, [webp, webp]))).status, 200, 'real WebP restores (deduped decode)');
    setup(); assert.equal((await restore((s) => members(s, [webp, fake()]))).status, 400, 'one fabricated WebP fails the whole restore');
    assert.equal(globalThis.__qaSpace.state.members.length, 0, 'nothing written');
    setup(); assert.equal((await restore((s) => { s.settings.name = 'data:image/webp club'; return s; })).status, 200, 'club name with the prefix is not a photo slot');
    delete process.env.NEXT_PUBLIC_PHOTO_WEBP;
    setup(); assert.ok((await restore((s) => members(s, [webp]))).status >= 400, 'flag OFF: WebP rejected');
  } finally { delete process.env.NEXT_PUBLIC_PHOTO_WEBP; }
});

test('HTTP v2 restore maps full queue to503 busy and leaves state untouched',async()=>{
 const {withDecodeGate,decodeLimits}=await import('../app/lib/photo-admission.ts');const old=decodeLimits.maxWaiting;process.env.NEXT_PUBLIC_PHOTO_WEBP='1';setup();let release;const running=withDecodeGate(()=>new Promise(r=>release=r));
 try{decodeLimits.maxWaiting=0;const response=await restore(s=>members(s,[webp]));assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'busy'});assert.equal(globalThis.__qaSpace.revision,0);assert.equal(globalThis.__qaSpace.state.members.length,0);
 }finally{release();await running;decodeLimits.maxWaiting=old;delete process.env.NEXT_PUBLIC_PHOTO_WEBP;}
});


test('abort during the post-decode current-state read is 503 busy and restores nothing',async()=>{
 setup();process.env.NEXT_PUBLIC_PHOTO_WEBP='1';const ac=new AbortController();let reads=0;
 try{globalThis.__reviewReadHook=()=>{reads++;ac.abort();};const state=members(emptyState(),[webp]);const backup={format:'gymos-backup',version:2,tenant:'qa-tenant',digest:createHash('sha256').update(JSON.stringify(state)).digest('hex'),state};const request=new Request('https://gym.example/api/backup',{method:'POST',headers:{origin:'https://gym.example','content-type':'application/json'},signal:ac.signal,body:JSON.stringify({action:'restore',confirm:'RESTORE',revision:0,backup})});const response=await POST(request);console.log('post-gate v2 abort',reads,ac.signal.aborted,response.status);assert.equal(reads,1);assert.equal(ac.signal.aborted,true);assert.equal(response.status,503);assert.equal(globalThis.__qaSpace.state.members.length,0);assert.equal(globalThis.__qaSpace.revision,0);
 }finally{delete globalThis.__reviewReadHook;delete process.env.NEXT_PUBLIC_PHOTO_WEBP;}
});
