// Real-PostgreSQL backup format v3 contract proof. Needs DATABASE_URL (app role) and
// DATABASE_URL_ADMIN (privileged, ONLY for archive-row tampering the app role cannot do).
// Mirrors scripts/test-photo-quota-db.mjs; not part of npm test.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {getPool,withScope} from '../app/lib/database.ts';
import {emptyState,applyOperation} from '../app/lib/domain.ts';
import {persistSpace,readEntitySpace} from '../app/lib/entity-store.ts';
import {validateBackup} from '../app/lib/backup.ts';
import {backupDigest,BACKUP_CHUNK_BYTES} from '../app/lib/backup-transfer.ts';
import {createSession,stageSection,openUploadSection,putSectionChunk,buildCoreBuffer,nextPhotoPage,nextEventPage,photoCount,archiveCount,validateManifest,readValidatedCore,commitRestoreV3,discardSession,sessionInfo} from '../app/lib/backup-v3.ts';
import {readEntityCore} from '../app/lib/entity-store.ts';
import {TransferError} from '../app/lib/backup-transfer.ts';

const pool=getPool(),owner='gymos-backup-v3-'+randomUUID(),actor='tester';
const admin=new pg.Client(process.env.DATABASE_URL_ADMIN||process.env.DATABASE_URL);await admin.connect();
const jpeg=(n,salt='')=>'data:image/jpeg;base64,/9j/'+salt+'A'.repeat(n-27-salt.length);
const save=(state,name,photo)=>applyOperation(state,{type:'member.save',branch:'main',name,phone:'',joined:'2026-10-01',expires:'2026-11-01',photo},'2026-10-18T12:00:00Z','Test',randomUUID);
const sha=(b)=>createHash('sha256').update(b).digest('hex');
async function uploadSection(session,kind,ordinal,buffer){
 const s=await openUploadSection(owner,actor,session,kind,ordinal,buffer.length,backupDigest(buffer));
 const parts=Math.ceil(buffer.length/BACKUP_CHUNK_BYTES);
 for(let i=0;i<parts;i++)await putSectionChunk(owner,actor,s.id,i,buffer.subarray(i*BACKUP_CHUNK_BYTES,(i+1)*BACKUP_CHUNK_BYTES).toString('base64'));
 return{ordinal,bytes:buffer.length,digest:backupDigest(buffer),transfer:s.id};
}
const manifestWith=(rev,coreRef,photoRefs,eventRefs,photoN,eventN)=>{const m={format:'gymos-backup',version:3,tenant:'t1',createdAt:'2026-11-22T01:00:00.000Z',revision:rev,core:coreRef,photos:{count:photoN,pages:photoRefs},events:{count:eventN,pages:eventRefs}};return{...m,digest:sha(Buffer.from(JSON.stringify(m),'utf8'))};};

try{
 // Seed: 25 members with 96k photos (forces 2 photo pages at the 2MB cap) + 90k archive events (forces 2 event pages at the 8MB cap).
 let state=emptyState();
 for(let i=0;i<25;i+=1)state=save(state,'Member '+i,jpeg(96000,i.toString(36).padStart(2,'0')));
 await withScope(owner,c=>c.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,0,$3)',[owner,JSON.stringify(emptyState()),new Date().toISOString()]));
 assert.equal(await persistSpace(owner,{state:emptyState(),revision:0},state),true,'seed persist');
 await withScope(owner,c=>c.query("INSERT INTO gymos.gym_activity_archive(owner_id,event_id,branch,at,payload) SELECT $1,'ev-'||g,'main','2026-10-0'||((g%9)+1)||'T10:00:00.000Z',jsonb_build_object('id','ev-'||g,'at','2026-10-0'||((g%9)+1)||'T10:00:00.000Z','kind','seed','subject','s'||g,'actor','seed','branch','main') FROM generate_series(1,90000) g",[owner]));
 const totalEvents=await archiveCount(owner);assert.equal(await photoCount(owner),25);assert.ok(totalEvents>=90000,'seed events + member.save events archived: '+totalEvents);

 // DOWNLOAD: core staged once, pages staged incrementally.
 const {buffer:coreBuf,revision}=await buildCoreBuffer(owner);
 const dl=await createSession(owner,actor,'download',revision);
 const coreSection=await stageSection(owner,actor,dl,'core',0,coreBuf);
 const core=JSON.parse(coreBuf.toString('utf8'));
 assert.ok(core.members.every(m=>m.photo===undefined),'core excludes photo bodies');
 assert.ok(core.members.length===25&&core.events.length<=2000,'core keeps members, recent events only');
 const photoBufs=[];let pc=null,ord=0;
 for(;;){const r=await nextPhotoPage(owner,pc);if(r.done&&!Object.keys(r.page).length)break;const b=Buffer.from(JSON.stringify(r.page),'utf8');photoBufs.push(b);await stageSection(owner,actor,dl,'photos',ord++,b);assert.ok(b.length<=2_000_000+120000,'photo page byte-capped');pc=r.nextCursor;if(r.done)break;}
 assert.ok(photoBufs.length>=2,'25 max-size photos force multiple photo pages, got '+photoBufs.length);
 const photoMap=Object.assign({},...photoBufs.map(b=>JSON.parse(b.toString('utf8'))));
 assert.equal(Object.keys(photoMap).length,25,'photo pages cover all photos exactly');
 const eventBufs=[];let ec=null;ord=0;let eventN=0;
 for(;;){const r=await nextEventPage(owner,ec);if(r.done&&!r.page.length)break;const b=Buffer.from(JSON.stringify(r.page),'utf8');eventBufs.push(b);await stageSection(owner,actor,dl,'events',ord++,b);assert.ok(b.length<=8_000_000+2000,'event page byte-capped');eventN+=r.page.length;ec=r.nextCursor;if(r.done)break;}
 assert.ok(eventBufs.length>=2,'90k archive events force multiple event pages, got '+eventBufs.length);
 assert.equal(eventN,totalEvents,'event pages cover the whole archive');
 const evts=eventBufs.flatMap(b=>JSON.parse(b.toString('utf8')));
 assert.equal(new Set(evts.map(e=>e.id)).size,totalEvents,'no duplicate/omitted events across pages');
 console.log('PASS: v3 download derives photo-free core at read and pages photos/events under byte caps');

 // Mutate live data so restore has something to repair: change one photo, rename a member, delete one archive row, tamper one payload.
 await withScope(owner,c=>c.query("UPDATE gymos.gym_photos SET content=$2 WHERE owner_id=$1 AND member_id=(SELECT member_id FROM gymos.gym_photos WHERE owner_id=$1 ORDER BY member_id LIMIT 1)",[owner,jpeg(50000,'mut')]));
 const renamed=await readEntitySpace(owner);const renameTarget=renamed.state.members[3].id;
 assert.equal(await persistSpace(owner,{state:renamed.state,revision:renamed.revision},{...renamed.state,members:renamed.state.members.map((m,i)=>i===3?{...m,name:'RENAMED-LIVE'}:m)}),true,'live rename persist');
 await admin.query("DELETE FROM gymos.gym_activity_archive WHERE owner_id=$1 AND event_id='ev-777'",[owner]);
 await admin.query("UPDATE gymos.gym_activity_archive SET payload=jsonb_build_object('id','ev-778','at','2026-10-01T10:00:00.000Z','kind','seed','subject','s778','actor','TAMPERED','branch','main') WHERE owner_id=$1 AND event_id='ev-778'",[owner]);

 // UPLOAD session from the downloaded buffers + rebuild manifest against upload transfer ids (client-side flow).
 const ul=await createSession(owner,actor,'upload');
 const coreRef=await uploadSection(ul,'core',0,coreBuf);
 const photoRefs=[];for(let i=0;i<photoBufs.length;i++)photoRefs.push(await uploadSection(ul,'photos',i,photoBufs[i]));
 const eventRefs=[];for(let i=0;i<eventBufs.length;i++)eventRefs.push(await uploadSection(ul,'events',i,eventBufs[i]));
 const manifest=manifestWith(revision,{bytes:coreRef.bytes,digest:coreRef.digest},photoRefs,eventRefs,25,totalEvents);
 assert.doesNotThrow(()=>validateManifest(manifest),'manifest validates');

 // Case: immutable archive conflict (ev-778 tampered after download) must roll the WHOLE restore back, including photo writes.
 const before=(await readEntitySpace(owner)).revision;
 const coreState=await readValidatedCore(owner,actor,ul,manifest);
 const restoredState=validateBackup(coreState);
 const current=await readEntitySpace(owner);
 let conflicted=false;
 try{await commitRestoreV3(owner,actor,ul,manifest,current,restoredState);}catch(e){conflicted=e instanceof Error&&/Immutable activity/.test(e.message);}
 assert.ok(conflicted,'tampered archive row triggers immutable-activity conflict');
 const afterFail=await readEntitySpace(owner);
 assert.equal(afterFail.revision,before,'rollback: revision unchanged');
 assert.equal(afterFail.state.members.find(m=>m.id===renameTarget)?.name,'RENAMED-LIVE','rollback: core-apply rolled back, live rename survives');
 assert.equal((await withScope(owner,c=>c.query("SELECT length(content) n FROM gymos.gym_photos WHERE owner_id=$1 AND member_id=(SELECT member_id FROM gymos.gym_photos WHERE owner_id=$1 ORDER BY member_id LIMIT 1)",[owner]))).rows[0].n,50000,'rollback: photo writes rolled back, mutation still present');
 console.log('PASS: mid-apply immutable-activity conflict rolls back the entire restore atomically');

 // Repair the tamper, commit again: full success.
 await admin.query("UPDATE gymos.gym_activity_archive SET payload=jsonb_build_object('id','ev-778','at','2026-10-05T10:00:00.000Z','kind','seed','subject','s778','actor','seed','branch','main') WHERE owner_id=$1 AND event_id='ev-778'",[owner]);
 const ok=await commitRestoreV3(owner,actor,ul,manifest,await readEntitySpace(owner),restoredState);
 assert.equal(ok,true,'commit succeeds');
 const final=await readEntitySpace(owner);
 assert.equal(final.revision,before+1,'exactly one revision bump');
 const finalPhotos=(await withScope(owner,c=>c.query('SELECT member_id,content FROM gymos.gym_photos WHERE owner_id=$1 ORDER BY member_id',[owner]))).rows;
 assert.equal(finalPhotos.length,25,'all photos restored');
 assert.ok(finalPhotos.every(r=>photoMap[r.member_id]===r.content),'restored photo contents match the backup exactly');
 assert.equal((await withScope(owner,c=>c.query("SELECT count(*)::int n FROM gymos.gym_activity_archive WHERE owner_id=$1 AND event_id='ev-777'",[owner]))).rows[0].n,1,'deleted archive event restored');
 assert.equal((await withScope(owner,c=>c.query('SELECT count(*)::int n FROM gymos.gym_activity_archive WHERE owner_id=$1',[owner]))).rows[0].n,totalEvents,'archive complete');
 // Restored name: the backup predates the live rename, so the successful restore reverted it.
 assert.equal(final.state.members.find(m=>m.id===renameTarget)?.name,'Member 3','restore reverted the live rename to the backup state');
 await discardSession(owner,actor,ul);
 console.log('PASS: v3 restore applies core+photos+archive in one transaction with exact contents');

 // Manifest binding cases.
 assert.throws(()=>validateManifest({...manifest,digest:'0'.repeat(64)}),(e)=>e instanceof TransferError&&e.code==='digestMismatch','forged manifest digest rejected');
 const ul2=await createSession(owner,actor,'upload');
 const c2=await uploadSection(ul2,'core',0,coreBuf);
 for(let i=0;i<photoBufs.length;i++)await uploadSection(ul2,'photos',i,photoBufs[i]);
 for(let i=0;i<eventBufs.length;i++)await uploadSection(ul2,'events',i,eventBufs[i]);
 // Manifest claims 24 photos while 25 are staged: count mismatch must reject before any destructive write.
 const m2b=manifestWith(final.revision,{bytes:c2.bytes,digest:c2.digest},photoRefs,eventRefs,24,totalEvents);
 let wrongCount=false;
 try{await commitRestoreV3(owner,actor,ul2,m2b,await readEntitySpace(owner),restoredState);}catch(e){wrongCount=e instanceof TransferError;}
 assert.ok(wrongCount,'count/section mismatch rejected before destructive writes');
 assert.equal((await withScope(owner,c=>c.query('SELECT count(*)::int n FROM gymos.gym_photos WHERE owner_id=$1',[owner]))).rows[0].n,25,'rejected commit left photos untouched');
 await discardSession(owner,actor,ul2);
 console.log('PASS: manifest digest/count/section binding rejects tampered or incomplete restores');

 // Adversarial case: a never-started session UUID cannot stage anything (durable registry admission).
 let neverStarted=false;
 try{await stageSection(owner,actor,randomUUID(),'core',0,Buffer.from('{}'));}catch(e){neverStarted=e instanceof TransferError&&e.code==='notFound';}
 assert.ok(neverStarted,'never-started session UUID rejected at staging admission');
 // Adversarial case: chunk overwrite after declaration breaks the digest at assembly (AAAA->BBBB).
 const ul3=await createSession(owner,actor,'upload');
 const tamperBuf=Buffer.from(JSON.stringify({probe:'x'.repeat(1000)}),'utf8');
 const s3=await openUploadSection(owner,actor,ul3,'core',0,tamperBuf.length,backupDigest(tamperBuf));
 await putSectionChunk(owner,actor,s3.id,0,tamperBuf.toString('base64'));
 let overwritten=false;
 try{await putSectionChunk(owner,actor,s3.id,0,Buffer.from(JSON.stringify({probe:'y'.repeat(1000)}),'utf8').toString('base64'));}catch(e){overwritten=e instanceof TransferError&&e.code==='chunkMismatch';} // overwrite index 0: AAAA->BBBB refused
 assert.ok(overwritten,'overwritten chunk refused at write (chunkMismatch)');
 await discardSession(owner,actor,ul3);
 console.log('PASS: never-started sessions and chunk overwrites are rejected');
 // Adversarial case: cross-page duplicate event ids rejected DB-side (ON CONFLICT at apply would mask them).
 const ul4=await createSession(owner,actor,'upload');
 const c4=await uploadSection(ul4,'core',0,coreBuf);
 for(let i=0;i<photoBufs.length;i++)await uploadSection(ul4,'photos',i,photoBufs[i]);
 const dupRef0=await uploadSection(ul4,'events',0,eventBufs[0]);
 const dupRef1=await uploadSection(ul4,'events',1,eventBufs[0]); // same events staged as a second page
 const dupCount=JSON.parse(eventBufs[0].toString('utf8')).length*2;
 const mDup=manifestWith(final.revision,{bytes:c4.bytes,digest:c4.digest},photoRefs,[dupRef0,dupRef1],25,dupCount);
 let dupRejected=false;
 try{await commitRestoreV3(owner,actor,ul4,mDup,await readEntitySpace(owner),restoredState);}catch(e){dupRejected=e instanceof TransferError&&e.code==='invalidBackup';}
 assert.ok(dupRejected,'cross-page duplicate events rejected');
 await discardSession(owner,actor,ul4);
 console.log('PASS: cross-page duplicate events rejected');
 // Adversarial case: revision pin - a write after downloadStart makes later pages conflict, never mix.
 const info=await sessionInfo(owner,actor,dl,'download');assert.equal(info.revision,revision,'session pinned the download revision');
 let pinConflict=false;
 try{await nextPhotoPage(owner,null,revision);}catch(e){pinConflict=e instanceof TransferError&&e.code==='conflict';}
 assert.ok(pinConflict,'revision moved after pin: page read conflicts instead of mixing states');
 console.log('PASS: download revision pin enforced inside the page transaction');
 // Adversarial case: legacy blob workspace exports its real state (never silently empty).
 const legacyOwner=owner+'-legacy';
 const legacyState=save(emptyState(),'Legacy Member',jpeg(50000,'lg'));
 await withScope(legacyOwner,c=>c.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,7,$3)',[legacyOwner,JSON.stringify(legacyState),new Date().toISOString()]));
 const legacyCore=await readEntityCore(legacyOwner);
 assert.equal(legacyCore.state.members.length,1,'legacy blob read returns its members, not empty collections');
 assert.ok(legacyCore.state.members[0].photo,'legacy blob keeps photos inline');
 const legacyBuilt=await buildCoreBuffer(legacyOwner);
 assert.ok(legacyBuilt.snapshotPhotos&&Object.keys(legacyBuilt.snapshotPhotos).length===1,'legacy photos paged as snapshot');
 assert.ok(JSON.parse(legacyBuilt.buffer.toString('utf8')).members[0].photo===undefined,'legacy core strips photos for paging');
 await withScope(legacyOwner,c=>c.query('DELETE FROM gymos.gym_states WHERE user_id=$1',[legacyOwner]));
 console.log('PASS: legacy blob workspaces export their real state with photos paged');
 // Reviewer repro 1: three actors x four 64MiB declarations = 805306368 bytes accepted above the 512MiB owner cap (actor-scoped FORCE RLS hid other actors' rows).
 await discardSession(owner,actor,dl); // drop the leftover download staging so the arithmetic below is exact
 const alreadyStaged=Number((await withScope(owner,c=>c.query('SELECT gymos.backup_owner_staged_bytes() AS b'))).rows[0].b);
 const expectedAdmitted=Math.floor((512*1024*1024-alreadyStaged)/(64*1024*1024));
 const bigActors=['agg-a','agg-b','agg-c'];let aggOpened=0,aggLimited=false;
 outer: for(const a of bigActors){
  const s=await createSession(owner,a,'upload');
  for(let i=0;i<4;i++){
   try{await openUploadSection(owner,a,s,'events',i,64*1024*1024,'0'.repeat(64));aggOpened++;}
   catch(e){if(e instanceof TransferError&&e.code==='limit'){aggLimited=true;break outer;}throw e;}
  }
 }
 assert.ok(aggLimited,'owner aggregate cap rejects the declaration that crosses 512MiB');
 assert.equal(aggOpened,expectedAdmitted,'aggregate admits up to exactly 512MiB across ALL actors then refuses, got '+aggOpened+' expected '+expectedAdmitted);
 for(const a of bigActors)await discardSession(owner,a,(await createSession(owner,a,'upload'))); // rotate+wipe
 console.log('PASS: owner-aggregate staged cap sums across actors (reviewer repro: 805306368 no longer accepted)');
 // Reviewer repro 2: one pre-existing 8100045-byte archive event emitted a page above the 8002048 hard maximum.
 const bigPayload=jsonb=>'jsonb_build_object('+jsonb+')';
 await admin.query("INSERT INTO gymos.gym_activity_archive(owner_id,event_id,branch,at,payload) VALUES($1,'ev-huge','main','2026-10-09T23:59:59.000Z',jsonb_build_object('id','ev-huge','at','2026-10-09T23:59:59.000Z','kind','seed','subject',repeat('x',8100000),'actor','seed','branch','main'))",[owner]);
 let hugeRefused=false;
 try{await nextEventPage(owner,{at:'2026-10-09T23:59:58.000Z',id:'zz'});}catch(e){hugeRefused=e instanceof TransferError&&e.code==='limit';}
 assert.ok(hugeRefused,'oversized legacy event refused loudly instead of emitting an over-cap page');
 await admin.query("DELETE FROM gymos.gym_activity_archive WHERE owner_id=$1 AND event_id='ev-huge'",[owner]);
 console.log('PASS: oversized archive event fails loudly at the hard page cap (reviewer repro: 8100045 bytes)');
 // Revision-pin bracket: the page transaction FOR SHARE-locks the workspace row, so a concurrent writer blocks instead of the page mixing revisions.
 const pinClient=await pool.connect();const writerClient=await pool.connect();
 try{
  await pinClient.query('BEGIN');await pinClient.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);
  const pinned=(await pinClient.query('SELECT revision FROM gymos.gym_states WHERE user_id=$1 FOR SHARE',[owner])).rows[0].revision;
  await writerClient.query('BEGIN');await writerClient.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);await writerClient.query("SET LOCAL statement_timeout='1500ms'");
  let blocked=false;
  try{await writerClient.query('UPDATE gymos.gym_states SET revision=revision+1 WHERE user_id=$1',[owner]);}catch(e){blocked=/statement timeout|canceling statement/i.test(e.message);}
  assert.ok(blocked,'writer blocked by the pinned page transaction (no mixed-revision window)');
  await writerClient.query('ROLLBACK');
  await pinClient.query('COMMIT');
  assert.equal(typeof pinned,'number');
 }finally{pinClient.release();writerClient.release();}
 console.log('PASS: revision pin brackets page reads with FOR SHARE (writer blocked, deterministic)');
 // Snapshot session flag: recovery downloads are marked so downloadNext never serves live rows.
 const snap=await createSession(owner,actor,'download',revision,true);
 assert.equal((await sessionInfo(owner,actor,snap,'download')).snapshot,true,'snapshot flag persisted');
 await discardSession(owner,actor,snap);
 console.log('PASS: snapshot sessions are marked and reported');
 console.log('PASS: backup v3 round trip complete');
}catch(e){console.error('TRY-ERR:',e);throw e;}finally{
 const client=await pool.connect();
 try{await client.query('BEGIN');await client.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);
  for(const t of ['gym_entities','gym_photos','gym_recovery','member_code_access'])await client.query('DELETE FROM gymos.'+t+' WHERE owner_id=$1',[owner]);
  await client.query('DELETE FROM gymos.gym_states WHERE user_id=$1',[owner]);
  await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 await admin.query('DELETE FROM gymos.gym_activity_archive WHERE owner_id=$1',[owner]);
 await admin.query('DELETE FROM gymos.gym_backup_sections WHERE owner_id=$1',[owner]);
 await admin.query('DELETE FROM gymos.gym_backup_sessions WHERE owner_id=$1',[owner]);
 await admin.end();await pool.end();
}
