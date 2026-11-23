// Envelope probe: peak process memory for hydrated vs core reads at 417 x 96k photos
// (the reviewer arithmetic case: 417 x 96k > 40,000,000 aggregate cap). Comparative,
// single-process, no GC forced - deltas are upper-ish bounds, labeled as such.
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {getPool,withScope} from '../app/lib/database.ts';
import {emptyState,applyOperation} from '../app/lib/domain.ts';
import {persistSpace,readEntitySpace,readEntityCore} from '../app/lib/entity-store.ts';
import {buildCoreBuffer} from '../app/lib/backup-v3.ts';

const owner='gymos-envelope-'+randomUUID();
const admin=new pg.Client(process.env.DATABASE_URL_ADMIN||process.env.DATABASE_URL);await admin.connect();
const N=Number(process.env.ENVELOPE_N||417),SIZE=96000;
const jpeg=(n,salt)=>('data:image/jpeg;base64,/9j/'+salt+'A'.repeat(n)).slice(0,n);
const mem=()=>{const m=process.memoryUsage();return Math.round((m.heapUsed+m.external)/1048576);};
try{
 // Seed photo rows SQL-side: this probe measures the READ envelope at the 417x96k
 // arithmetic case, which persistSpace correctly refuses (PhotoQuotaExceeded, verified).
 let state=emptyState();
 for(let i=0;i<N;i+=1)state=applyOperation(state,{type:'member.save',branch:'main',name:'M'+i,phone:'',joined:'2026-10-01',expires:'2026-11-01'},'2026-10-18T12:00:00Z','T',randomUUID);
 await withScope(owner,c=>c.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,0,$3)',[owner,JSON.stringify(emptyState()),new Date().toISOString()]));
 const seeded=await persistSpace(owner,{state:emptyState(),revision:0},state);
 if(!seeded)throw new Error('seed persist failed');
 const ids=state.members.map(m=>m.id);
 await withScope(owner,async c=>{for(let i=0;i<ids.length;i+=100){const batch=ids.slice(i,i+100);await c.query('INSERT INTO gymos.gym_photos(owner_id,member_id,content) SELECT $1,x.id,$3 FROM jsonb_to_recordset($2::jsonb) AS x(id text)',[owner,JSON.stringify(batch.map(id=>({id}))),jpeg(SIZE,'bulk')]);}});
 const photoBytes=(await withScope(owner,c=>c.query('SELECT COALESCE(SUM(length(content)),0)::bigint n FROM gymos.gym_photos WHERE owner_id=$1',[owner]))).rows[0].n;

 let m0=mem();
 const full=await readEntitySpace(owner);
 const dFull=mem()-m0;
 const fullJson=JSON.stringify(full.state).length;

 m0=mem();
 const core=await readEntityCore(owner);
 const dCore=mem()-m0;
 const coreJson=JSON.stringify(core.state).length;

 m0=mem();
 const built=await buildCoreBuffer(owner);
 const dBuf=mem()-m0;

 console.log(JSON.stringify({members:N,photoBytes:Number(photoBytes),readEntitySpace_deltaMB:dFull,readEntitySpace_stateJsonMB:Math.round(fullJson/1048576),readEntityCore_deltaMB:dCore,readEntityCore_stateJsonMB:Math.round(coreJson/1048576),buildCoreBuffer_deltaMB:dBuf,coreBufferBytes:built.buffer.length,snapshotPhotosCount:built.snapshotPhotos?Object.keys(built.snapshotPhotos).length:0}));
 for(const t of ['gym_recovery_photos','gym_entities','gym_photos','gym_recovery','member_code_access'])await admin.query('DELETE FROM gymos.'+t+' WHERE owner_id=$1',[owner]);
 await admin.query('DELETE FROM gymos.gym_states WHERE user_id=$1',[owner]);
}catch(e){console.error('FAILED:',e);process.exitCode=1;}
finally{await admin.end();await getPool().end();}
