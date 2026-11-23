// Real-PostgreSQL photo capacity contract proof. Needs DATABASE_URL pointing at a
// scratch database already bootstrapped with the full schema chain (base files +
// supabase/migrations). Mirrors scripts/test-entity-db.mjs; not part of npm test.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {getPool,withScope} from '../app/lib/database.ts';
import {emptyState,applyOperation} from '../app/lib/domain.ts';
import {persistSpace,readEntitySpace} from '../app/lib/entity-store.ts';
import {PhotoQuotaExceeded,PHOTO_TOTAL_BYTE_LIMIT} from '../app/lib/photo-budget.ts';
import pg from 'pg';

const pool=getPool(),owner='gymos-photo-test-'+randomUUID();
// Privileged client ONLY for counter-table setup/teardown the app role must not be able to do (gymos_app has no write grant on gym_entity_counters by design).
const admin=new pg.Client(process.env.DATABASE_URL_ADMIN||process.env.DATABASE_URL);await admin.connect();
const jpeg=(n,salt='')=>'data:image/jpeg;base64,/9j/'+salt+'A'.repeat(n-27-salt.length);
const save=(state,name,photo)=>applyOperation(state,{type:'member.save',branch:'main',name,phone:'',joined:'2026-10-01',expires:'2026-11-01',photo},'2026-10-18T12:00:00Z','Test',randomUUID);

try{
 let state=emptyState();
 assert.equal(await persistSpace(owner,{state,revision:-1},state),false,'no owner row yet');
 // Bootstrap the owner row like a fresh club (revision 0 insert happens through the app setup path).
 await withScope(owner,c=>c.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,0,$3)',[owner,JSON.stringify(state),new Date().toISOString()]));
 // 209 members, each with a distinct max-size (96,000-char) photo: the reviewer counterexample.
 for(let i=0;i<209;i+=1)state=save(state,'Member '+i,jpeg(96000,i.toString(36).padStart(2,'0')));
 assert.ok(new TextEncoder().encode(JSON.stringify(state)).length>20_000_000,'assembled state exceeds the old monolithic envelope');
 assert.equal(await persistSpace(owner,{state:emptyState(),revision:0},state),true,'209-photo persist must succeed');
 const loaded=await readEntitySpace(owner);
 assert.equal(Object.keys(loaded.state.members.filter(m=>m.photo)).length,209,'all photos round-trip');
 const total=Number((await withScope(owner,c=>c.query('SELECT SUM(length(content)) n FROM gymos.gym_photos WHERE owner_id=$1',[owner]))).rows[0].n);
 assert.equal(total,209*96000);
 // Quota admission reads the trigger-maintained counter (no per-write photo scan):
 const counterBytes=Number((await withScope(owner,c=>c.query("SELECT payload_bytes FROM gymos.gym_entity_counters WHERE owner_id=$1 AND collection='photos'",[owner]))).rows[0].payload_bytes);
 assert.ok(counterBytes>=209*96000,'photos counter maintained by triggers');
 const {readCounters}=await import('../app/lib/workspace-slice.ts');
 const k=await withScope(owner,c=>readCounters(c,owner));
 assert.ok(k&&k.counts.photos===209,'counters still count photo rows');
 assert.ok(k.bytes<2_000_000,'core byte bound must exclude stored photo bodies, got '+k.bytes);
 console.log('PASS: 209 max-size photos persist and round-trip beyond the 20MB core envelope');
 console.log('PASS: counters keep exact photo counts but exclude photo bodies from the core byte bound');

 // Push the owner to the photo budget with filler rows, then one more photo write must fail atomically.
 const filler=Math.ceil((PHOTO_TOTAL_BYTE_LIMIT-total)/96000)+1;
 await withScope(owner,c=>c.query("INSERT INTO gymos.gym_photos(owner_id,member_id,content) SELECT $1,'filler-'||g,'data:image/jpeg;base64,/9j/'||repeat('A',95973) FROM generate_series(1,$2) g ON CONFLICT(owner_id,member_id) DO NOTHING",[owner,filler]));
 const before=(await readEntitySpace(owner)).revision;
 let quotaThrown=false;
 try{await persistSpace(owner,{state:loaded.state,revision:before},save(loaded.state,'One More',jpeg(96000,'zz')));}catch(e){quotaThrown=e instanceof PhotoQuotaExceeded;}
 assert.ok(quotaThrown,'over-budget photo write must throw PhotoQuotaExceeded');
 const after=await readEntitySpace(owner);
 assert.equal(after.revision,before,'rollback: revision unchanged');
 assert.equal((await withScope(owner,c=>c.query("SELECT 1 FROM gymos.gym_photos WHERE owner_id=$1 AND member_id NOT LIKE 'filler-%' AND length(content)=96000",[owner]))).rows.length,209,'rollback: original photos intact, new photo absent');
 console.log('PASS: photo budget enforced atomically (PhotoQuotaExceeded, full rollback)');
 console.log('child connection role:',(await withScope(owner,c=>c.query('SELECT current_user u'))).rows[0].u);

 // Reviewer 03:14 regression: delta-only counter rows without _ready must never bypass quota.
 // 417 legacy photos stored directly (models pre-quota data): 417*96000 = 40,032,000 chars, over budget.
 const owner2='gymos-photo-unready-'+randomUUID();
 let s0=emptyState();
 for(let i=0;i<417;i+=1)s0=save(s0,'Legacy '+i,jpeg(96000,i.toString(36).padStart(2,'0')));
 await withScope(owner2,c=>c.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,0,$3)',[owner2,JSON.stringify(emptyState()),new Date().toISOString()]));
 for(const m of s0.members)await withScope(owner2,c=>c.query('INSERT INTO gymos.gym_photos(owner_id,member_id,content) VALUES($1,$2,$3)',[owner2,m.id,m.photo]));
 await admin.query('DELETE FROM gymos.gym_entity_counters WHERE owner_id=$1',[owner2]);
 // Ordinary photo update shortening one photo by 1 char: the trigger creates a delta-only photos row of -1 byte in-transaction, with no _ready marker.
 const s1={...s0,members:s0.members.map((m,i)=>i===0?{...m,photo:m.photo.slice(0,-1)}:m)};
 let unreadyThrown=false;
 try{await persistSpace(owner2,{state:s0,revision:0},s1);}catch(e){unreadyThrown=e instanceof PhotoQuotaExceeded;}
 assert.ok(unreadyThrown,'unready delta-only counter must not bypass quota: exact-SUM fallback must reject the over-budget write');
 assert.equal((await withScope(owner2,c=>c.query('SELECT count(*) n FROM gymos.gym_photos WHERE owner_id=$1',[owner2]))).rows[0].n,'417','rollback: legacy photos intact');
 assert.equal((await withScope(owner2,c=>c.query('SELECT count(*) n FROM gymos.gym_entity_counters WHERE owner_id=$1',[owner2]))).rows[0].n,'0','rollback: delta-only counter row rolled back');
 assert.equal((await withScope(owner2,c=>c.query('SELECT length(content) n FROM gymos.gym_photos WHERE owner_id=$1 AND member_id=$2',[owner2,s0.members[0].id]))).rows[0].n,96000,'rollback: shortened photo unchanged');
 console.log('PASS: unready delta-only counter rows fall back to exact SUM and reject over-budget writes (reviewer 03:14 case)');

 // Corrupt negative counter WITH _ready present must also fall back to exact SUM.
 await admin.query("INSERT INTO gymos.gym_entity_counters(owner_id,collection,row_count,payload_bytes) VALUES($1,'_ready',0,0),($1,'photos',-1,-1)",[owner2]);
 let corruptThrown=false;
 try{await persistSpace(owner2,{state:s0,revision:0},s1);}catch(e){corruptThrown=e instanceof PhotoQuotaExceeded;}
 assert.ok(corruptThrown,'negative counter with _ready must not bypass quota');
 console.log('PASS: corrupt negative counters fail over to exact SUM even with _ready present');
 for(const t of ['gym_entities','gym_photos','gym_recovery','member_code_access'])await withScope(owner2,c=>c.query('DELETE FROM gymos.'+t+' WHERE owner_id=$1',[owner2]));
 await admin.query('DELETE FROM gymos.gym_entity_counters WHERE owner_id=$1',[owner2]);
 await withScope(owner2,c=>c.query('DELETE FROM gymos.gym_states WHERE user_id=$1',[owner2]));
}finally{
 const client=await pool.connect();
 try{await client.query('BEGIN');await client.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);
  for(const t of ['gym_entities','gym_photos','gym_recovery','member_code_access'])await client.query('DELETE FROM gymos.'+t+' WHERE owner_id=$1',[owner]);
  await client.query('DELETE FROM gymos.gym_states WHERE user_id=$1',[owner]);
  await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();await pool.end();await admin.end();}
}
