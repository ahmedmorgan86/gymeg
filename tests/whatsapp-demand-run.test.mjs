import {test} from 'node:test';import assert from 'node:assert/strict';import {registerHooks} from 'node:module';import {bootstrapDb} from './db-bootstrap-helpers.mjs';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}}});
const {enqueueWhatsAppPage}=await import('../app/lib/whatsapp-demand-run.ts');
const {splitState}=await import('../app/lib/entity-state.ts');const {emptyState}=await import('../app/lib/domain.ts');
const db=await bootstrapDb(),owner='durable-synthetic',now='2026-03-15T12:00:00.000Z';
const s=emptyState();s.settings.timezone='Africa/Cairo';s.members=Array.from({length:577},(_,i)=>({id:'m'+i,name:'Member'+i,branch:'main',phone:'+201000000001',joined:'2026-01-01',expires:'2026-12-31',whatsapp:{enabled:true}}));
const {metadata,entities}=splitState(s);await db.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,1,$3)',[owner,JSON.stringify(metadata),now]);
for(const e of entities)await db.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',[owner,e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);
const rule={id:'6bbba33d-e170-4cd3-a14e-cc503d477457',branch:'main',name:'Test',kind:'occasion',enabled:true,time:'00:00',template:'test',language:'ar',offset:2,date:'2026-03-15',parameters:[],createdAt:'2025-12-25T00:00:00Z'};
let batches=0,readCursor;
const scope=(o,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);return work({query:async(sql,p)=>{if(sql.startsWith('INSERT INTO gymos.whatsapp_outbox')){batches++;assert.ok(JSON.parse(p[3]).length<=250);}const r=await c.query(sql,p);if(sql.startsWith('SELECT cursor'))readCursor=r.rows[0]?.cursor;return r;}});});
const count=async()=>Number((await db.query('SELECT count(*) AS n FROM gymos.whatsapp_outbox WHERE owner_id=$1',[owner])).rows[0].n);
const cursor=async()=>(await db.query('SELECT cursor FROM gymos.whatsapp_scan_cursor WHERE owner_id=$1',[owner])).rows[0]?.cursor;
test('bounded atomic pages persist progress across independent calls and wrap without duplicate outbox ids',async()=>{
 for(const [expected,more] of [[250,true],[500,true],[577,false]]){const r=await enqueueWhatsAppPage(scope,{owner,rule,now,deadline:Date.now()+5000});assert.equal(await count(),expected);assert.equal(r.more,more);}
 assert.equal(await cursor(),null);assert.equal(batches,3);
 await enqueueWhatsAppPage(scope,{owner,rule,now,deadline:Date.now()+5000});assert.equal(await count(),577);assert.equal((await cursor()).position,249);
 // Reloaded module/process would use this same stored cursor, not page one.
 await enqueueWhatsAppPage(scope,{owner,rule,now,deadline:Date.now()+5000});assert.equal(readCursor.position,249);assert.equal((await cursor()).position,499);
});
test('deadline after bulk insert rolls back both rows and cursor; no full-state fallback; same DB is usable',async()=>{
 const newRule={...rule,id:'6bbba33d-e170-4cd3-a14e-cc503d477458'};let expired=false;
 const delayed=(o,work)=>scope(o,c=>work({query:async(sql,p)=>{const r=await c.query(sql,p);if(sql.startsWith('INSERT INTO gymos.whatsapp_outbox'))expired=true;return r;}}));
 const realNow=Date.now;let fake=realNow();Date.now=()=>expired?fake+6000:fake;
 try{await assert.rejects(enqueueWhatsAppPage(delayed,{owner,rule:newRule,now,deadline:fake+5000}),e=>e.reason==='deadline');}finally{Date.now=realNow;}
 assert.equal(Number((await db.query('SELECT count(*) AS n FROM gymos.whatsapp_outbox WHERE owner_id=$1 AND rule_id=$2',[owner,newRule.id])).rows[0].n),0);
 assert.equal((await db.query('SELECT cursor FROM gymos.whatsapp_scan_cursor WHERE owner_id=$1 AND rule_id=$2',[owner,newRule.id])).rows.length,0);
 assert.equal((await db.query('SELECT 1 AS ok')).rows[0].ok,1);
});
test('real-clock delayed statements stop at the next budget check and release the transaction',async()=>{
 const slow=(o,work)=>scope(o,c=>work({query:async(sql,p)=>{const r=await c.query(sql,p);await new Promise(done=>setTimeout(done,40));return r;}}));
 const started=Date.now();await assert.rejects(enqueueWhatsAppPage(slow,{owner,rule,now,deadline:started+100}),e=>e.reason==='deadline');
 const elapsed=Date.now()-started;assert.ok(elapsed>=100&&elapsed<700,'elapsed '+elapsed);assert.equal((await db.query('SELECT 1 AS ok')).rows[0].ok,1);
 console.log('real-clock delayed statement budget elapsed_ms='+elapsed);
});
test('odd data and missing prerequisites defer without advancing progress or generating jobs',async()=>{
 await db.query("UPDATE gymos.gym_states SET payload=jsonb_set(payload::jsonb,'{_entityStorage}','0')::text WHERE user_id=$1",[owner]);
 const before=await cursor(),n=await count();await assert.rejects(enqueueWhatsAppPage(scope,{owner,rule,now,deadline:Date.now()+5000}),e=>e.reason==='layout');assert.deepEqual(await cursor(),before);assert.equal(await count(),n);
 await db.exec('DROP TABLE gymos.whatsapp_scan_cursor');await assert.rejects(enqueueWhatsAppPage(scope,{owner,rule,now,deadline:Date.now()+5000}),e=>e.reason==='cursor-migration');assert.equal(await count(),n);
 await db.close();
});
