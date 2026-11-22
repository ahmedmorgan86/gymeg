// Pre-assembly v2 download admission (assertV2DownloadBudget): real-PG evidence that the
// 64MB body bound fires BEFORE hydration, via SQL-side source sizes only. Cases:
//  1. under-limit owner -> resolves
//  2. over-limit photos -> TransferError limit/413, fast (no hydration)
//  3. counter row missing -> SUM(length(content)) fallback, same verdict
//  4. over-limit recovery snapshot -> limit/413 with recoveryId
//  5. under-limit recovery snapshot -> resolves
//  6. unsafe counter value -> fail-closed limit/413
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {getPool,withScope} from '../app/lib/database.ts';
import {emptyState} from '../app/lib/domain.ts';
import {assertV2DownloadBudget,TransferError} from '../app/lib/backup-transfer.ts';

const admin=new pg.Client(process.env.DATABASE_URL_ADMIN||process.env.DATABASE_URL);await admin.connect();
const pad=(n)=>repeatStr('A',n);
const repeatStr=(ch,n)=>ch.repeat(n);
let passed=0,failed=0;
const ok=(name,cond)=>{if(cond){passed++;console.log('PASS',name);}else{failed++;console.log('FAIL',name);}};
const verdict=async(owner,recoveryId)=>{const t0=Date.now();try{await assertV2DownloadBudget(owner,'admin-1',recoveryId);return{accepted:true,ms:Date.now()-t0};}catch(e){if(e instanceof TransferError)return{accepted:false,code:e.code,status:e.status,ms:Date.now()-t0};throw e;}};

const seed=async(tag,{photos=0,photoBytes=0,events=0,corePad=0}={})=>{
 const owner='gymos-budget-'+tag+'-'+randomUUID();
 await withScope(owner,c=>c.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,0,$3)',[owner,JSON.stringify({...emptyState(),_entityStorage:1,pad:corePad?pad(corePad):''}),new Date().toISOString()]));
 if(photos)await withScope(owner,c=>c.query('INSERT INTO gymos.gym_photos(owner_id,member_id,content) SELECT $1,\'m\'||g,repeat(\'A\',$3::int) FROM generate_series(1,$2::int) g',[owner,photos,photoBytes]));
 if(events)await withScope(owner,c=>c.query("INSERT INTO gymos.gym_activity_archive(owner_id,event_id,branch,at,payload) SELECT $1,'ev-'||g,'main','2026-10-01T10:00:00.000Z',jsonb_build_object('id','ev-'||g,'at','2026-10-01T10:00:00.000Z','kind','seed','subject','s'||g,'actor','seed','branch','main') FROM generate_series(1,$2::int) g",[owner,events]));
 return owner;
};

// 1: under limit
const under=await seed('under',{photos:80,photoBytes:96_000,events:1000});
const v1=await verdict(under);
ok('under-limit accepted',v1.accepted===true);

// 2: over limit (photos 80MB) - fast rejection
const over=await seed('over',{photos:900,photoBytes:96_000}); // 86.4MB of photos: over the 64MB body budget, each photo within its 96k content CHECK
const v2=await verdict(over);
ok('over-limit rejected 413 limit',v2.accepted===false&&v2.code==='limit'&&v2.status===413);
ok('over-limit rejection fast (<2000ms)',v2.ms<2000);
console.log('  over-limit rejection ms:',v2.ms);

// 3: counter fallback
await admin.query("DELETE FROM gymos.gym_entity_counters WHERE owner_id=$1 AND collection='photos'",[over]); // admin: gymos_app has SELECT-only on counters
const v3=await verdict(over);
ok('counter-missing SUM fallback still rejects',v3.accepted===false&&v3.code==='limit');

// 4+5: recovery snapshots
const rid=randomUUID();
const rOwner=await seed('rec',{events:10});
await withScope(rOwner,c=>c.query('INSERT INTO gymos.gym_recovery(id,owner_id,payload,created_at) VALUES($1,$2,$3,$4)',[rid,rOwner,JSON.stringify({small:true}),new Date().toISOString()]));
await withScope(rOwner,c=>c.query('INSERT INTO gymos.gym_recovery_photos(recovery_id,owner_id,member_id,content) SELECT $1,$2,\'m\'||g,repeat(\'A\',96000) FROM generate_series(1,900) g',[rid,rOwner]));
const v4=await verdict(rOwner,rid);
ok('over-limit recovery rejected 413 limit',v4.accepted===false&&v4.code==='limit'&&v4.status===413);
const v5=await verdict(rOwner);
ok('live under-limit (recovery rows excluded) accepted',v5.accepted===true);

// 6: fail-closed on unsafe counter
const weird=await seed('weird',{photos:1,photoBytes:100});
await admin.query("UPDATE gymos.gym_entity_counters SET payload_bytes=-5 WHERE owner_id=$1 AND collection='photos'",[weird]); // admin: gymos_app has SELECT-only on counters
const v6=await verdict(weird);
ok('negative counter fails closed 413',v6.accepted===false&&v6.code==='limit');

await admin.end();await getPool().end();
console.log(failed?`FAILURES: ${failed}`:'ALL PASS',`(${passed} passed)`);
process.exit(failed?1:0);
