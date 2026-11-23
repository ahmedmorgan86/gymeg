import {readFileSync} from 'node:fs';
import {test,after} from 'node:test';import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
// REAL backup v3 session -> sections -> commitRestoreV3 over PGlite with the real migrations. Synthetic data only.
import {registerHooks,stripTypeScriptTypes} from 'node:module';
globalThis.__imageDecodeCalls=0;globalThis.__v3RestoreTx=0;const real=globalThis.__v3Db=await bootstrapDb();delete process.env.GYMOS_COMMERCIAL;
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}},load(url,c,n){
 if(url.endsWith('/app/lib/photo-decode.ts'))return{format:'module',shortCircuit:true,source:stripTypeScriptTypes(readFileSync(new URL(url),'utf8').replace(' const kind=photoDataUrlKind',' globalThis.__imageDecodeCalls++;if(globalThis.__v3RestoreTx)throw Error("decode inside restore transaction"); const kind=photoDataUrlKind'))};
 if(url.endsWith('/app/lib/database.ts'))return{format:'module',shortCircuit:true,source:`export const getPool=()=>({connect:async()=> (globalThis.__reviewConnectHook?.(), {query:async(s,v)=>{globalThis.__onQuery?.(s);if(s==='BEGIN')globalThis.__v3RestoreTx++;try{return await globalThis.__v3Db.query(s,v);}finally{if(s==='COMMIT'||s==='ROLLBACK')globalThis.__v3RestoreTx--;}},release(){}})});export async function withScope(owner,work){return globalThis.__v3Db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);return work(c);});}export const db={prepare(){throw Error("unexpected")},async batch(){throw Error("unexpected")}};`};
 if(url.endsWith('/app/lib/firestore-db.ts'))return{format:'module',shortCircuit:true,source:'export const getFirestoreDb=()=>{throw Error("unexpected")};export const isFirestorePersistence=()=>false;export const firestorePersistSpace=()=>{throw Error("unexpected")};export const firestoreReadSpace=()=>{throw Error("unexpected")};export const firestoreCachedSpace=()=>null;export const isFirebaseConfigured=()=>false;'};
 if(url.endsWith('/app/lib/realtime-broadcast.ts'))return{format:'module',shortCircuit:true,source:'export const processWorkspaceOutbox=async()=>{};'};return n(url,c);
}});
after(()=>real.close());
const {createSession,openUploadSection,putSectionChunk,commitRestoreV3,validateManifest}=await import('../app/lib/backup-v3.ts');
const {BACKUP_CHUNK_BYTES,TransferError}=await import('../app/lib/backup-transfer.ts');
const {readEntityCore}=await import('../app/lib/entity-store.ts');
const {splitState}=await import('../app/lib/entity-state.ts');
const {emptyState,applyOperation}=await import('../app/lib/domain.ts');
import sharp from 'sharp';
const sha=(b)=>createHash('sha256').update(b).digest('hex');
const webp=async(w=320,bg='#468')=>'data:image/webp;base64,'+(await sharp({create:{width:w,height:w,channels:3,background:bg}}).webp({quality:80}).toBuffer()).toString('base64');
const fake=()=>{const b=Buffer.alloc(30);b.write('RIFF',0);b.writeUInt32LE(22,4);b.write('WEBPVP8 ',8);b.writeUInt32LE(10,16);b.set([0x9d,1,0x2a],23);b.writeUInt16LE(64,26);b.writeUInt16LE(64,28);return 'data:image/webp;base64,'+b.toString('base64');};
const photoOf=async(o,id)=>(await real.query('SELECT content FROM gymos.gym_photos WHERE owner_id=$1 AND member_id=$2',[o,id])).rows[0]?.content;
const photoCount=async(o)=>(await real.query('SELECT count(*)::int n FROM gymos.gym_photos WHERE owner_id=$1',[o])).rows[0].n;

function clubState(n){let st=emptyState();st.settings.timezone='Africa/Cairo';for(let i=0;i<n;i++){st=applyOperation(st,{type:'member.save',branch:'main',name:'Member '+(i+1),phone:'0100000'+String(i).padStart(4,'0'),joined:'2026-10-01',expires:'2026-12-01'},'2026-11-22T10:00:00Z','T',randomUUID);}return st;}
async function seed(owner,state){
  const {metadata,entities}=splitState(state);
  for(const t of ['gym_entities','gym_states','gym_photos'])await real.query(`DELETE FROM gymos.${t} WHERE ${t==='gym_states'?'user_id':'owner_id'}=$1`,[owner]);
  await real.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,5,$3)',[owner,JSON.stringify({...metadata,_entityStorage:1,_activityArchive:1}),new Date().toISOString()]);
  for(const e of entities)await real.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',[owner,e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);
}
async function stage(owner,actor,session,kind,ordinal,content){
  const buf=Buffer.from(content),digest=sha(buf),opened=await openUploadSection(owner,actor,session,kind,ordinal,buf.length,digest);
  for(let i=0;i<opened.parts;i++)await putSectionChunk(owner,actor,opened.id,i,buf.subarray(i*BACKUP_CHUNK_BYTES,(i+1)*BACKUP_CHUNK_BYTES).toString('base64'));
  return {ordinal,bytes:buf.length,digest,transfer:opened.id};
}
async function restoreOf(owner,actor,photos,{members=3,tamperCount}={}){
  const state=clubState(members),ids=state.members.map(m=>m.id);
  const session=await createSession(owner,actor,'upload');
  const core=Buffer.from(JSON.stringify(state)),coreRef=await stage(owner,actor,session,'core',0,core);
  const page=Object.fromEntries(photos.map((p,i)=>[ids[i],p])),pageRef=photos.length?await stage(owner,actor,session,'photos',0,JSON.stringify(page)):null;
  const rest={format:'gymos-backup',version:3,tenant:'t-'+owner,createdAt:new Date().toISOString(),revision:0,core:{bytes:core.length,digest:coreRef.digest},photos:{count:tamperCount??photos.length,pages:pageRef?[pageRef]:[]},events:{count:0,pages:[]}};
  const manifest=validateManifest({...rest,digest:sha(Buffer.from(JSON.stringify(rest)))});
  return {session,manifest,ids};
}
const current=(owner)=>readEntityCore(owner);

test('REAL v3 session + PGlite commit: flag ON restores real WebP portraits byte-exact; fabricated or malformed restores fail BEFORE the transaction and change nothing',async()=>{
  const owner='v3-owner',actor='v3-actor';
  try{
    process.env.NEXT_PUBLIC_PHOTO_WEBP='1';
    const a=await webp(320,'#468'),b=await webp(320,'#a64');
    await seed(owner,clubState(1));
    let {session,manifest,ids}=await restoreOf(owner,actor,[a,b,a]);
    assert.equal(await commitRestoreV3(owner,actor,session,manifest,await current(owner)),true);
    assert.equal(await photoOf(owner,ids[0]),a);assert.equal(await photoOf(owner,ids[1]),b);assert.equal(await photoOf(owner,ids[2]),a);
    assert.equal(await photoCount(owner),3);assert.ok(globalThis.__imageDecodeCalls>=2);
    // A fabricated WebP page entry: rejected, existing restored photos untouched, no transaction left open.
    ({session,manifest}=await restoreOf(owner,actor,[fake(),a]));const beforeFake=globalThis.__imageDecodeCalls;
    await assert.rejects(async()=>commitRestoreV3(owner,actor,session,manifest,await current(owner)),(e)=>e instanceof TransferError);
    assert.equal(await photoCount(owner),3,'nothing written');assert.ok(globalThis.__imageDecodeCalls>beforeFake,'structurally valid fake reaches full decoder');assert.equal(globalThis.__v3RestoreTx,0);
    await real.query('SELECT 1'); // the connection is usable: no stranded BEGIN
    // Cheap rejection BEFORE decode: wrong declared count and an orphan photo id fail on shape, not after image work.
    ({session,manifest}=await restoreOf(owner,actor,[a],{tamperCount:5}));const beforeBadCount=globalThis.__imageDecodeCalls;
    await assert.rejects(async()=>commitRestoreV3(owner,actor,session,manifest,await current(owner)),(e)=>e instanceof TransferError);
    assert.equal(await photoCount(owner),3);
    assert.equal(globalThis.__imageDecodeCalls,beforeBadCount,'invalid manifest count rejected before decoder');
    // Flag OFF: the same real WebP restore is refused by the legacy JPEG-only predicate inside the commit, rolled back.
    delete process.env.NEXT_PUBLIC_PHOTO_WEBP;
    ({session,manifest}=await restoreOf(owner,actor,[a]));
    await assert.rejects(async()=>commitRestoreV3(owner,actor,session,manifest,await current(owner)),(e)=>e instanceof TransferError);
    assert.equal(await photoCount(owner),3,'rolled back');
  }finally{delete process.env.NEXT_PUBLIC_PHOTO_WEBP;}
});

test('v3 prevalidation: decode runs before BEGIN, so concurrent restores do not hold DB locks while decoding; the gate serialises decode work',async()=>{
  const {withDecodeGate}=await import('../app/lib/photo-admission.ts');
  const order=[];let active=0,maxActive=0;
  const job=(n)=>withDecodeGate(async()=>{active++;maxActive=Math.max(maxActive,active);order.push('s'+n);await new Promise(r=>setTimeout(r,15));order.push('e'+n);active--;});
  await Promise.all([job(1),job(2),job(3)]);
  assert.equal(maxActive,1);assert.deepEqual(order,['s1','e1','s2','e2','s3','e3']);
  await assert.rejects(()=>withDecodeGate(async()=>{throw Error('boom');}));
  assert.equal(await withDecodeGate(async()=>'still works'),'still works','a failed job does not poison the gate');
});

test('stale same-owner snapshot cannot overwrite a completed restore from another actor',async()=>{
 const owner='v3-conflict-review';process.env.NEXT_PUBLIC_PHOTO_WEBP='1';
 try{await seed(owner,clubState(1));const good=await webp();const first=await restoreOf(owner,'actor-one',[good]),second=await restoreOf(owner,'actor-two',[good]);const old=await current(owner);
 assert.equal(await commitRestoreV3(owner,'actor-one',first.session,first.manifest,old),true);const revision=(await current(owner)).revision;
 assert.equal(await commitRestoreV3(owner,'actor-two',second.session,second.manifest,old),false);assert.equal((await current(owner)).revision,revision);assert.equal(await photoOf(owner,first.ids[0]),good);assert.equal(await photoOf(owner,second.ids[0]),undefined);
 }finally{delete process.env.NEXT_PUBLIC_PHOTO_WEBP;}
});

test('malformed event page is now rejected before full image decode',async()=>{
 const owner='v3-event-precheck-review',actor='event-actor';process.env.NEXT_PUBLIC_PHOTO_WEBP='1';
 try{await seed(owner,clubState(1));const staged=await restoreOf(owner,actor,[await webp()]);const eventRef=await stage(owner,actor,staged.session,'events',0,JSON.stringify({not:'an event array'}));
 const {digest,...rest}=staged.manifest;rest.events={count:1,pages:[eventRef]};const manifest=validateManifest({...rest,digest:sha(Buffer.from(JSON.stringify(rest)))});
 const before=globalThis.__imageDecodeCalls,cur=await current(owner);await assert.rejects(()=>commitRestoreV3(owner,actor,staged.session,manifest,cur),e=>e instanceof TransferError);
 assert.equal(globalThis.__imageDecodeCalls,before,'malformed event rejected before sharp');assert.equal(await photoCount(owner),0);
 }finally{delete process.env.NEXT_PUBLIC_PHOTO_WEBP;}
});

test('v3 zero-WebP restore never enters the gate (held gate, no queue room): restores JPEG portraits; WebP restore is 503 busy with no BEGIN',async()=>{
 const {withDecodeGate,decodeLimits}=await import('../app/lib/photo-admission.ts');const owner='v3-fast',actor='fast-actor';process.env.NEXT_PUBLIC_PHOTO_WEBP='1';
 const old={...decodeLimits};let release;const running=withDecodeGate(()=>new Promise(r=>release=r));
 try{decodeLimits.maxWaiting=0;await seed(owner,clubState(1));
  const jpeg='data:image/jpeg;base64,'+(await sharp({create:{width:64,height:64,channels:3,background:'#468'}}).jpeg().toBuffer()).toString('base64');
  let st=await restoreOf(owner,actor,[jpeg]);assert.equal(await commitRestoreV3(owner,actor,st.session,st.manifest,await current(owner)),true);assert.equal(await photoOf(owner,st.ids[0]),jpeg);
  const tx=globalThis.__v3RestoreTx;const w=await restoreOf(owner,'fast-actor2',[await webp()]);
  await assert.rejects(async()=>commitRestoreV3(owner,'fast-actor2',w.session,w.manifest,await current(owner)),e=>e instanceof TransferError&&e.status===503);
  assert.equal(globalThis.__v3RestoreTx,tx,'no BEGIN on busy');assert.equal(await photoOf(owner,w.ids[0]),undefined);
 }finally{release();await running;Object.assign(decodeLimits,old);delete process.env.NEXT_PUBLIC_PHOTO_WEBP;}
});

test('v3 restore aborted before the decode/BEGIN boundary writes nothing and opens no transaction',async()=>{
 const owner='v3-abort',actor='abort-actor';process.env.NEXT_PUBLIC_PHOTO_WEBP='1';
 try{await seed(owner,clubState(1));const st=await restoreOf(owner,actor,[await webp()]);const ac=new AbortController();ac.abort();const tx=globalThis.__v3RestoreTx,before=globalThis.__imageDecodeCalls;
  await assert.rejects(async()=>commitRestoreV3(owner,actor,st.session,st.manifest,await current(owner),undefined,ac.signal),e=>e instanceof TransferError&&e.status===503);
  assert.equal(globalThis.__v3RestoreTx,tx);assert.equal(globalThis.__imageDecodeCalls,before);assert.equal(await photoCount(owner),0);
 }finally{delete process.env.NEXT_PUBLIC_PHOTO_WEBP;}
});


test('abort while pool.connect resolves after prevalidation: no BEGIN, no write',async()=>{
 const owner='v3-abort-connect',actor='review-actor';process.env.NEXT_PUBLIC_PHOTO_WEBP='1';
 try{await seed(owner,clubState(1));const good=await webp(),st=await restoreOf(owner,actor,[good]),cur=await current(owner);const ac=new AbortController();let connects=0;globalThis.__reviewConnectHook=()=>{if(++connects===5)ac.abort();};await assert.rejects(async()=>commitRestoreV3(owner,actor,st.session,st.manifest,cur,undefined,ac.signal),e=>e instanceof TransferError&&e.status===503);delete globalThis.__reviewConnectHook;assert.equal(ac.signal.aborted,true);assert.equal(globalThis.__v3RestoreTx,0);assert.equal(await photoCount(owner),0,'no BEGIN, no photo');
 }finally{delete globalThis.__reviewConnectHook;delete process.env.NEXT_PUBLIC_PHOTO_WEBP;}
});

test('v3 abort after the commit transaction opened, caught before COMMIT, rolls the whole restore back (no claim about anything after COMMIT)',async()=>{
 const owner='v3-abort-precommit',actor='precommit-actor';process.env.NEXT_PUBLIC_PHOTO_WEBP='1';
 try{await seed(owner,clubState(1));const good=await webp(),st=await restoreOf(owner,actor,[good]),cur=await current(owner);const ac=new AbortController();const q=[];
  globalThis.__onQuery=(sql)=>{q.push(String(sql).slice(0,8));if(String(sql).includes('ORDER BY kind,ordinal FOR UPDATE'))ac.abort();}; // the COMMIT transaction's own locked section read: first statement after its BEGIN
  await assert.rejects(async()=>commitRestoreV3(owner,actor,st.session,st.manifest,cur,undefined,ac.signal),e=>e instanceof TransferError&&e.status===503);
  globalThis.__onQuery=undefined;
  const tail=q.slice(q.lastIndexOf('BEGIN'));assert.ok(tail.includes('UPDATE g')&&tail.at(-1)==='ROLLBACK'&&!tail.includes('COMMIT'),'the last (commit) transaction applied its writes, then ended with ROLLBACK and no COMMIT: '+'BEGIN was issued, ROLLBACK ran, COMMIT never did: '+tail.join(','));
  assert.equal(globalThis.__v3RestoreTx,0);assert.equal(await photoCount(owner),0);assert.equal((await current(owner)).revision,cur.revision);
 }finally{globalThis.__onQuery=undefined;delete process.env.NEXT_PUBLIC_PHOTO_WEBP;}
});
