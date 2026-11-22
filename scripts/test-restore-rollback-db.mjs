import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {getPool,withScope} from '../app/lib/database.ts';
import {emptyState,applyOperation} from '../app/lib/domain.ts';
import {persistSpace,readEntitySpace,readEntityCore} from '../app/lib/entity-store.ts';
import {backupDigest,BACKUP_CHUNK_BYTES} from '../app/lib/backup-transfer.ts';
import {createSession,openUploadSection,putSectionChunk,buildCoreBuffer,nextPhotoPage,nextEventPage,validateManifest,readValidatedCore,commitRestoreV3,discardSession} from '../app/lib/backup-v3.ts';
import {validateBackup} from '../app/lib/backup.ts';

const owner='gymos-restore-rb-'+randomUUID(),actor='tester';
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
 // Seed: 3 members with small photos (v3 entity storage).
 let state=emptyState();
 for(let i=0;i<3;i+=1)state=save(state,'Member '+i,jpeg(2000,'s'+i));
 await withScope(owner,c=>c.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,0,$3)',[owner,JSON.stringify(emptyState()),new Date().toISOString()]));
 assert.equal(await persistSpace(owner,{state:emptyState(),revision:0},state),true,'seed persist');
 const backupPhotos=Object.fromEntries((await withScope(owner,c=>c.query('SELECT member_id,content FROM gymos.gym_photos WHERE owner_id=$1 ORDER BY member_id',[owner]))).rows.map(r=>[r.member_id,r.content]));
 assert.equal(Object.keys(backupPhotos).length,3,'seed photos in table');

 // DOWNLOAD (backup set = the 3 original photos).
 const {buffer:coreBuf,revision}=await buildCoreBuffer(owner);
 const dl=await createSession(owner,actor,'download',revision);
 await createSession(owner,actor,'download',revision).then(()=>{});
 const photoBufs=[];let pc,ord=0;
 for(;;){const r=await nextPhotoPage(owner,pc);if(r.done&&!Object.keys(r.page).length)break;photoBufs.push(Buffer.from(JSON.stringify(r.page),'utf8'));pc=r.nextCursor;if(r.done)break;}
 const eventBufs=[];let ec,eventN=0;ord=0;
 for(;;){const r=await nextEventPage(owner,ec);if(r.done&&!r.page.length)break;eventBufs.push(Buffer.from(JSON.stringify(r.page),'utf8'));eventN+=r.page.length;ec=r.nextCursor;if(r.done)break;}
 assert.ok(photoBufs.length>=1&&eventBufs.length>=1,'download produced pages');

 // MUTATE live state post-download: overwrite one photo, add a 4th member with photo.
 const victim=Object.keys(backupPhotos)[0];
 await withScope(owner,c=>c.query('UPDATE gymos.gym_photos SET content=$3 WHERE owner_id=$1 AND member_id=$2',[owner,victim,jpeg(3000,'mut')]));
 const cur=await readEntitySpace(owner);
 const mutatedState=save(cur.state,'Member late',jpeg(4000,'late'));
 assert.equal(await persistSpace(owner,{state:cur.state,revision:cur.revision},mutatedState),true,'late member persist');
 const preRestore=(await withScope(owner,c=>c.query('SELECT member_id,content FROM gymos.gym_photos WHERE owner_id=$1 ORDER BY member_id',[owner]))).rows;
 assert.equal(preRestore.length,4,'pre-restore photo set has 4 rows (1 mutated, 1 new)');

 // UPLOAD + COMMIT restore (production route passes readEntityCore).
 const ul=await createSession(owner,actor,'upload');
 const coreRef=await uploadSection(ul,'core',0,coreBuf);
 const photoRefs=[];for(let i=0;i<photoBufs.length;i++)photoRefs.push(await uploadSection(ul,'photos',i,photoBufs[i]));
 const eventRefs=[];for(let i=0;i<eventBufs.length;i++)eventRefs.push(await uploadSection(ul,'events',i,eventBufs[i]));
 const manifest=manifestWith(revision,coreRef,photoRefs,eventRefs,3,eventN);
 validateManifest(manifest);
 const restoredState=validateBackup(await readValidatedCore(owner,actor,ul,manifest));
 const ok=await commitRestoreV3(owner,actor,ul,manifest,await readEntityCore(owner),(s)=>s);
 assert.equal(ok,true,'restore committed');

 // 1) Live photos now exactly the backup set.
 const post=(await withScope(owner,c=>c.query('SELECT member_id,content FROM gymos.gym_photos WHERE owner_id=$1 ORDER BY member_id',[owner]))).rows;
 assert.equal(post.length,3,'restore replaced the photo set');
 for(const r of post)assert.equal(r.content,backupPhotos[r.member_id],'restored content matches backup: '+r.member_id);

 // 2) The restore wrote ONE gym_recovery row whose payload is core-only (no photo data).
 const rec=(await withScope(owner,c=>c.query('SELECT id,payload FROM gymos.gym_recovery WHERE owner_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[owner]))).rows[0];
 assert.ok(rec,'recovery row written');
 assert.ok(!rec.payload.includes('data:image/jpeg'),'recovery core payload carries no photo data (SQL-side preservation holds the photos)');

 // 3) gym_recovery_photos holds the FULL pre-restore set for that recovery id.
 const kept=(await withScope(owner,c=>c.query('SELECT member_id,content FROM gymos.gym_recovery_photos WHERE owner_id=$1 AND recovery_id=$2 ORDER BY member_id',[owner,rec.id]))).rows;
 assert.deepEqual(kept,preRestore,'preserved set equals the exact pre-restore photo set');
 // 3a) Composite FK: even with a known recovery id, another owner's scope cannot reference it.
 let fkBlocked=false;
 try{await withScope('intruder-'+randomUUID(),c=>c.query("INSERT INTO gymos.gym_recovery_photos(recovery_id,owner_id,member_id,content) VALUES($1,$2,'x','data:image/jpeg;base64,/9j/AAAA')",[rec.id,'intruder-'+owner]));}catch(e){fkBlocked=true;}
 assert.ok(fkBlocked,'cross-owner recovery reference rejected (RLS scope + composite FK)');
 // 3b) Tenant scoping: another owner sees nothing (RLS).
 await withScope('someone-else-'+randomUUID(),async c=>{
  const n=(await c.query('SELECT count(*)::int n FROM gymos.gym_recovery_photos WHERE recovery_id=$1',[rec.id])).rows[0].n;
  assert.equal(n,0,'cross-tenant read blocked by RLS');
 });

 // 4) Recovery download reproduces the pre-restore photos (merged from gym_recovery_photos).
 const rebuilt=await buildCoreBuffer(owner,rec.id);
 assert.ok(rebuilt.selfContained,'recovery download self-contained');
 const snap=Object.assign({},rebuilt.snapshotPhotos);
 assert.deepEqual(snap,Object.fromEntries(preRestore.map(r=>[r.member_id,r.content])),'recovery download snapshot photos = preserved set');
 assert.ok(!rebuilt.buffer.toString('utf8').includes('data:image/jpeg'),'recovery core buffer itself still photo-free');

 await discardSession(owner,actor,ul);
 for(const t of ['gym_recovery_photos','gym_entities','gym_photos','gym_recovery','member_code_access'])await admin.query('DELETE FROM gymos.'+t+' WHERE owner_id=$1',[owner]);
 await admin.query("DELETE FROM gymos.gym_states WHERE user_id=$1",[owner]);
 console.log('PASS: restore preserves the pre-restore photo set SQL-side (rollback complete, core stays bounded), recovery download rebuilds it');
}catch(error){console.error('FAILED:',error);process.exitCode=1;}
finally{await admin.end();await getPool().end();}
