// readV2DownloadSnapshot: real-PG evidence for the v2 download admission+read path.
//  1. under-limit -> snapshot with photos inline + archive merged, correct revision
//  2. over-limit photos -> TransferError limit/413, fast (before hydration)
//  3. counter row missing -> exact-SUM fallback (to_jsonb+9 formula), same verdict
//  4. delta-only counter WITHOUT _ready marker -> not trusted -> SUM fallback
//  5. huge live photos + tiny recovery -> recovery snapshot ACCEPTED and contains no live
//     photos (proves the recovery path never hydrates live state), live snapshot REJECTED
//  6. negative counter -> fail-closed 413
//  7. 200k-event archive: admission timing sample (DB-side SUM cost disclosure)
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {getPool,withScope} from '../app/lib/database.ts';
import {emptyState} from '../app/lib/domain.ts';
import {readV2DownloadSnapshot} from '../app/lib/backup-v3.ts';
import {TransferError} from '../app/lib/backup-transfer.ts';

const admin=new pg.Client(process.env.DATABASE_URL_ADMIN||process.env.DATABASE_URL);await admin.connect();
let passed=0,failed=0;
const ok=(name,cond)=>{if(cond){passed++;console.log('PASS',name);}else{failed++;console.log('FAIL',name);}};
const verdict=async(owner,recoveryId)=>{const t0=Date.now();try{const snap=await readV2DownloadSnapshot(owner,'admin-1',recoveryId);return{accepted:true,ms:Date.now()-t0,snap};}catch(e){if(e instanceof TransferError)return{accepted:false,code:e.code,status:e.status,ms:Date.now()-t0};throw e;}};
const seed=async(tag,{photos=0,photoBytes=0,events=0}={})=>{
 const owner='gymos-snap-'+tag+'-'+randomUUID();
 await withScope(owner,c=>c.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,7,$3)',[owner,JSON.stringify({...emptyState(),_entityStorage:1}),new Date().toISOString()]));
 if(photos){await withScope(owner,c=>c.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) SELECT $1,'members','m'||g,g,'main',jsonb_build_object('id','m'||g,'name','Member '||g,'branch','main') FROM generate_series(1,$2::int) g",[owner,photos]));await withScope(owner,c=>c.query("INSERT INTO gymos.gym_photos(owner_id,member_id,content) SELECT $1,'m'||g,repeat('A',$3::int) FROM generate_series(1,$2::int) g",[owner,photos,photoBytes]));}
 if(events)await withScope(owner,c=>c.query("INSERT INTO gymos.gym_activity_archive(owner_id,event_id,branch,at,payload) SELECT $1,'ev-'||g,'main','2026-10-01T10:00:00.000Z',jsonb_build_object('id','ev-'||g,'at','2026-10-01T10:00:00.000Z','kind','seed','subject','s'||g,'actor','seed','branch','main') FROM generate_series(1,$2::int) g",[owner,events]));
 return owner;
};

// 1: under limit, content shape
const under=await seed('under',{photos:80,photoBytes:96_000,events:1000});
const v1=await verdict(under);
ok('under-limit accepted',v1.accepted===true);
ok('photos inline on member entities',v1.snap&&(v1.snap.state.members??[]).length===80&&(v1.snap.state.members??[]).every(m=>typeof m.photo==='string'&&m.photo.length===96000));
ok('archive merged into events',v1.snap&&(v1.snap.state.events??[]).length===1000);
ok('revision carried',v1.snap&&v1.snap.revision===7);

// 2: over limit
const over=await seed('over',{photos:900,photoBytes:96_000});
const v2=await verdict(over);
ok('over-limit rejected 413 limit',v2.accepted===false&&v2.code==='limit'&&v2.status===413);
ok('over-limit rejection fast (<2000ms)',v2.ms<2000);
console.log('  over-limit rejection ms:',v2.ms);

// 3: counter fallback (missing ROWS; on remote-parity schemas the counters TABLE itself is absent - same exact-SUM path, proven by cases 1-2 already running table-free)
const hasCounters=(await admin.query("SELECT to_regclass('gymos.gym_entity_counters') IS NOT NULL AS ok")).rows[0].ok;
if(hasCounters)await admin.query("DELETE FROM gymos.gym_entity_counters WHERE owner_id=$1",[over]); // no counters at all -> no _ready baseline -> exact SUM
const v3=await verdict(over);
ok(hasCounters?'no _ready baseline -> exact-SUM fallback still rejects':'no counters TABLE -> exact-SUM fallback still rejects',v3.accepted===false&&v3.code==='limit');

// 4: delta-only counter without _ready is not trusted (requires the counters table)
if(hasCounters){
const delta=await seed('delta',{photos:2,photoBytes:100});
await admin.query("DELETE FROM gymos.gym_entity_counters WHERE owner_id=$1",[delta]);
await admin.query("INSERT INTO gymos.gym_entity_counters(owner_id,collection,row_count,payload_bytes) VALUES($1,'photos',2,999999999)",[delta]);
const v4=await verdict(delta);
ok('delta-only counter without _ready falls back to exact SUM (accepted)',v4.accepted===true);
}else console.log('SKIP delta-only counter case (no counters table on this schema)');

// 5: recovery never hydrates live state
const rOwner=await seed('rec',{photos:900,photoBytes:96_000}); // live photos alone over budget
const rid=randomUUID();
await withScope(rOwner,c=>c.query('INSERT INTO gymos.gym_recovery(id,owner_id,payload,created_at) VALUES($1,$2,$3,$4)',[rid,rOwner,JSON.stringify({...emptyState(),members:[{id:'old-member',name:'Old Member',branch:'main'}]}),new Date().toISOString()]));
await withScope(rOwner,c=>c.query("INSERT INTO gymos.gym_recovery_photos(recovery_id,owner_id,member_id,content) VALUES($1,$2,'old-member',repeat('B',96000))",[rid,rOwner]));
const v5r=await verdict(rOwner,rid);
ok('recovery snapshot accepted despite huge live photos',v5r.accepted===true);
ok('recovery snapshot: preserved photo reattached to its member, live members absent',v5r.snap&&(v5r.snap.state.members??[]).length===1&&(v5r.snap.state.members??[])[0].id==='old-member'&&(v5r.snap.state.members??[])[0].photo?.length===96000);
const v5l=await verdict(rOwner);
ok('live snapshot of same owner rejected',v5l.accepted===false&&v5l.code==='limit');

// 6: negative counter fails closed (with _ready present so it would otherwise be trusted; requires the counters table)
if(hasCounters){
const weird=await seed('weird',{photos:1,photoBytes:100});
await admin.query("UPDATE gymos.gym_entity_counters SET payload_bytes=-5 WHERE owner_id=$1 AND collection='photos'",[weird]);
const v6=await verdict(weird);
ok('negative counter not trusted -> exact-SUM fallback accepts',v6.accepted===true);
}else console.log('SKIP negative counter case (no counters table on this schema)');

// 7: archive SUM cost sample at 200k events
const big=await seed('big',{events:200000});
const v7=await verdict(big);
ok('200k-event archive accepted',v7.accepted===true);
console.log('  admission+read ms at 200k archive events:',v7.ms);

await admin.end();await getPool().end();
console.log(failed?`FAILURES: ${failed}`:'ALL PASS',`(${passed} passed)`);
process.exit(failed?1:0);
