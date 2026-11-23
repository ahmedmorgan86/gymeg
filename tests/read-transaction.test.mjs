import {test} from 'node:test';import assert from 'node:assert/strict';
import {readTransaction,MAX_PENDING_READ_ACQUIRES} from '../app/lib/read-transaction.ts';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function client(query){const log=[],released=[];return{log,released,query:async(sql,p)=>{log.push(sql);return query?query(sql,p):{rows:[]};},release:x=>released.push(Boolean(x))};}
test('expired clock never acquires; timed-out queue releases a late client without SQL or callback',async()=>{
 let calls=0;await assert.rejects(readTransaction({connect:async()=>{calls++;return client();}},Date.now()-1,async()=>0),{name:'ReadDatabaseDeadline'});assert.equal(calls,0);
 let deliver,worked=false;const c=client();const run=readTransaction({connect:()=>new Promise(r=>deliver=r)},Date.now()+25,async()=>{worked=true;});await assert.rejects(run,{name:'ReadDatabaseDeadline'});deliver(c);await wait(1);assert.equal(worked,false);assert.deepEqual(c.log,[]);assert.deepEqual(c.released,[false]);
});
test('pending acquisitions have an explicit admission cap, including expired-but-not-yet-delivered waits',async()=>{
 const deferred=[],clients=[];const pool={connect:()=>new Promise(r=>deferred.push(r))};
 const runs=Array.from({length:MAX_PENDING_READ_ACQUIRES},()=>readTransaction(pool,Date.now()+30,async()=>{}).catch(e=>e.name));await wait(1);
 await assert.rejects(readTransaction(pool,Date.now()+30,async()=>{}),{name:'ReadDatabaseBusy'});assert.deepEqual(await Promise.all(runs),Array(MAX_PENDING_READ_ACQUIRES).fill('ReadDatabaseDeadline'));
 await assert.rejects(readTransaction(pool,Date.now()+30,async()=>{}),{name:'ReadDatabaseBusy'});
 for(const resolve of deferred){const c=client();clients.push(c);resolve(c);}await wait(1);assert.ok(clients.every(c=>c.log.length===0&&c.released.length===1));
});
test('read-only scope commits normally; a SQL cancellation rolls back before safe reuse',async()=>{
 let fail=true;const c=client(async sql=>{if(sql==='SELECT canceled'&&fail){fail=false;const e=new Error('canceled');e.code='57014';throw e;}return{rows:[]};});const pool={connect:async()=>c};
 await assert.rejects(readTransaction(pool,Date.now()+200,async c=>c.query('SELECT canceled'),'owner'),e=>e.code==='57014');assert.ok(c.log.includes('ROLLBACK'));assert.deepEqual(c.released,[false]);
 await readTransaction(pool,Date.now()+200,async c=>c.query('SELECT safe'),'owner');assert.equal(c.log.at(-1),'COMMIT');assert.deepEqual(c.released,[false,false]);assert.ok(c.log.includes('BEGIN READ ONLY'));
});
test('deadline during in-flight SQL destroys connection; no late callback can start more SQL',async()=>{
 const c=client(async sql=>sql==='SELECT blocked'?new Promise(()=>{}):{rows:[]});await assert.rejects(readTransaction({connect:async()=>c},Date.now()+25,c=>c.query('SELECT blocked')),{name:'ReadDatabaseDeadline'});assert.deepEqual(c.released,[true]);assert.equal(c.log.includes('ROLLBACK'),false);
 const late=client();await assert.rejects(readTransaction({connect:async()=>late},Date.now()+20,async c=>{await wait(40);return c.query('SELECT late');}),{name:'ReadDatabaseDeadline'});await wait(30);assert.equal(late.log.includes('SELECT late'),false);assert.deepEqual(late.released,[true]);
});
test('unknown rollback state is destroyed, never returned as a usable transaction',async()=>{
 const c=client(async sql=>{if(sql==='ROLLBACK')throw Error('network');return{rows:[]};});await assert.rejects(readTransaction({connect:async()=>c},Date.now()+200,async()=>{throw Error('work failed');}),/work failed/);assert.deepEqual(c.released,[true]);
});

test('failed BEGIN has unknown state and is destroyed without callback execution',async()=>{
 let worked=false;const c=client(async()=>{throw Error('begin connection failed');});await assert.rejects(readTransaction({connect:async()=>c},Date.now()+200,async()=>{worked=true;}),/begin connection failed/);assert.equal(worked,false);assert.deepEqual(c.released,[true]);
});
test('retained handle refuses after successful commit and ordinary failure without touching released lease',async()=>{
 for(const fails of [false,true]){const c=client();let retained;const run=readTransaction({connect:async()=>c},Date.now()+500,async q=>{retained=q;if(fails)throw Error('ordinary');return 3;});if(fails)await assert.rejects(run,/ordinary/);else assert.equal(await run,3);const before=c.log.length;await assert.rejects(retained.query('SELECT retained'),{name:'ReadTransactionClosed'});assert.equal(c.log.length,before);assert.equal(c.released.length,1);}
});
test('detached query cannot pass timeout setup after callback closes transaction',async()=>{
 let setupResolve;const c=client(sql=>sql.startsWith('SELECT set_config')?new Promise(r=>setupResolve=r):Promise.resolve({rows:[]}));let detached;
 await readTransaction({connect:async()=>c},Date.now()+500,async q=>{detached=q.query('SELECT detached').catch(e=>e.name);return 1;});
 setupResolve({rows:[]});assert.equal(await detached,'ReadTransactionClosed');assert.ok(!c.log.includes('SELECT detached'));assert.deepEqual(c.released,[false]);
});
