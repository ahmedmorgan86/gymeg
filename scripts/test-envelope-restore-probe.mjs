// Restore-commit envelope at 417x96k: peak process memory sampled every 5ms during
// commitRestoreV3. Sections pre-staged before sampling so the measurement isolates
// the commit itself. No GC control: peak is an upper-ish bound, labeled as such.
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {getPool,withScope} from '../app/lib/database.ts';
import {emptyState,applyOperation} from '../app/lib/domain.ts';
import {persistSpace,readEntityCore} from '../app/lib/entity-store.ts';
import {backupDigest,BACKUP_CHUNK_BYTES} from '../app/lib/backup-transfer.ts';
import {createSession,buildCoreBuffer,nextPhotoPage,nextEventPage,commitRestoreV3} from '../app/lib/backup-v3.ts';

const owner='gymos-env-rst-'+randomUUID(),actor='tester';
const admin=new pg.Client(process.env.DATABASE_URL_ADMIN||process.env.DATABASE_URL);await admin.connect();
const N=Number(process.env.ENVELOPE_N||417),SIZE=96000;
const jpeg=(n,salt)=>('data:image/jpeg;base64,/9j/'+salt+'A'.repeat(n)).slice(0,n);
const mem=()=>{const m=process.memoryUsage();return Math.round((m.heapUsed+m.external)/1048576);};
const sha=b=>createHash('sha256').update(b).digest('hex');
// SQL-side staging: one INSERT per section with the exact final row openUploadSection+
// putSectionChunk would produce (the per-chunk RPC path is the test bottleneck, not the
// code under measurement). commitRestoreV3 reads these rows unchanged.
async function up(session,kind,ordinal,buffer){
 const id=randomUUID(),digest=backupDigest(buffer),chunks={};
 for(let i=0,parts=Math.ceil(buffer.length/BACKUP_CHUNK_BYTES);i<parts;i++)chunks[String(i)]=buffer.subarray(i*BACKUP_CHUNK_BYTES,(i+1)*BACKUP_CHUNK_BYTES).toString('base64');
 await withScope(owner,async c=>{await c.query("SELECT set_config('app.gym_actor',$1,true)",[actor]);await c.query("INSERT INTO gymos.gym_backup_sections(id,session_id,owner_id,actor_id,direction,kind,ordinal,bytes,digest,chunks) VALUES($1,$2,$3,$4,'upload',$5,$6,$7,$8,$9)",[id,session,owner,actor,kind,ordinal,buffer.length,digest,JSON.stringify(chunks)]);});
 return{ordinal,bytes:buffer.length,digest,transfer:id};
}
try{
 let state=emptyState();
 for(let i=0;i<N;i+=1)state=applyOperation(state,{type:'member.save',branch:'main',name:'M'+i,phone:'',joined:'2026-10-01',expires:'2026-11-01'},'2026-10-18T12:00:00Z','T',randomUUID);
 await withScope(owner,c=>c.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,0,$3)',[owner,JSON.stringify(emptyState()),new Date().toISOString()]));
 if(!await persistSpace(owner,{state:emptyState(),revision:0},state))throw new Error('seed');
 const ids=state.members.map(m=>m.id);
 await withScope(owner,async c=>{for(let i=0;i<ids.length;i+=100)await c.query('INSERT INTO gymos.gym_photos(owner_id,member_id,content) SELECT $1,x.id,$3 FROM jsonb_to_recordset($2::jsonb) AS x(id text)',[owner,JSON.stringify(ids.slice(i,i+100).map(id=>({id}))),jpeg(SIZE,'a')]);});

 // Download (backup set = 'a' photos), then overwrite live photos with 'b' variant.
 const {buffer:coreBuf,revision}=await buildCoreBuffer(owner);
 const photoBufs=[];let pc;
 for(;;){const r=await nextPhotoPage(owner,pc);if(r.done&&!Object.keys(r.page).length)break;photoBufs.push(Buffer.from(JSON.stringify(r.page),'utf8'));pc=r.nextCursor;if(r.done)break;}
 const eventBufs=[];let ec,eventN=0;
 for(;;){const r=await nextEventPage(owner,ec);if(r.done&&!r.page.length)break;eventBufs.push(Buffer.from(JSON.stringify(r.page),'utf8'));eventN+=r.page.length;ec=r.nextCursor;if(r.done)break;}
 await withScope(owner,c=>c.query('UPDATE gymos.gym_photos SET content=$2 WHERE owner_id=$1',[owner,jpeg(SIZE,'b')]));

 // Pre-stage upload session BEFORE sampling.
 const ul=await createSession(owner,actor,'upload');
 const coreRef=await up(ul,'core',0,coreBuf);
 const photoRefs=[];for(let i=0;i<photoBufs.length;i++)photoRefs.push(await up(ul,'photos',i,photoBufs[i]));
 const eventRefs=[];for(let i=0;i<eventBufs.length;i++)eventRefs.push(await up(ul,'events',i,eventBufs[i]));
 const m0={format:'gymos-backup',version:3,tenant:'t1',createdAt:'2026-11-22T01:00:00.000Z',revision,core:coreRef,photos:{count:N,pages:photoRefs},events:{count:eventN,pages:eventRefs}};
 const manifest={...m0,digest:sha(Buffer.from(JSON.stringify(m0),'utf8'))};

 let peak=0;const t=setInterval(()=>{const m=mem();if(m>peak)peak=m;},5);
 const before=mem(),t0=Date.now();
 const ok=await commitRestoreV3(owner,actor,ul,manifest,await readEntityCore(owner),(s)=>s);
 const commitMs=Date.now()-t0;clearInterval(t);
 const after=mem();
 console.log(JSON.stringify({members:N,photoBytes:N*SIZE,photoPages:photoBufs.length,commitOk:ok,commitMs,constrainedRuntime:'--max-old-space-size='+process.execArgv.join(' '),nodeOptions:process.env.NODE_OPTIONS||'',beforeMB:before,peakMB:peak,afterMB:after,peakDeltaMB:peak-before}));
 for(const tb of ['gym_recovery_photos','gym_entities','gym_photos','gym_recovery','member_code_access'])await admin.query('DELETE FROM gymos.'+tb+' WHERE owner_id=$1',[owner]);
 await admin.query('DELETE FROM gymos.gym_states WHERE user_id=$1',[owner]);
}catch(e){console.error('FAILED:',e);process.exitCode=1;}
finally{await admin.end();await getPool().end();}
