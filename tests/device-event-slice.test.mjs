import {test} from 'node:test';import assert from 'node:assert/strict';import {registerHooks} from 'node:module';import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const db=globalThis.__deviceDb=await bootstrapDb();
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}},load(url,c,n){if(url.endsWith('/app/lib/realtime-broadcast.ts'))return{format:'module',shortCircuit:true,source:'export const processWorkspaceOutbox=async()=>{};'};if(url.endsWith('/app/lib/database.ts'))return{format:'module',shortCircuit:true,source:`export const getPool=()=>({connect:async()=>({query:(sql,v)=>globalThis.__deviceDb.query(sql,v),release(){}})});`};return n(url,c);}});
const {emptyState,applyOperation}=await import('../app/lib/domain.ts');const {emptyEngagement}=await import('../app/lib/engagement.ts');const {splitState}=await import('../app/lib/entity-state.ts');const {postgresBackend}=await import('../app/lib/workspace-slice.ts');const {normalize}=await import('../app/lib/extensions.ts');const {readEntitySpace,persistSpace}=await import('../app/lib/entity-store.ts');const {ingestDeviceEvent}=await import('../app/lib/device-bridge.ts');const {tryDeviceSlice}=await import('../app/lib/device-event-slice.ts');
const now='2026-03-15T12:00:00.000Z',today='2026-03-15';
const be=postgresBackend((o,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);return work(c);}));
let n=0;const newid=()=>String(++n)+'-00000000-0000-0000-0000';
function fixture(){let s=normalize(emptyState());s=applyOperation(s,{type:'member.save',branch:'main',name:'Synthetic Person',phone:'+201000000001',joined:today,expires:'2026-12-31'},now,'QA',newid);s=applyOperation(s,{type:'member.save',branch:'main',name:'Unrelated Person',phone:'+201000000002',joined:today,expires:'2026-12-31'},now,'QA',newid);s.events=[];s.engagement=emptyEngagement();s.engagement.devices=[{id:'device',branch:'main',name:'Synthetic',enabled:true,mappings:[{person:'sensor',member:s.members[0].id}]}];return s;}
async function seed(owner,s){const {metadata,entities}=splitState(s);await db.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,1,$3)',[owner,JSON.stringify({...metadata,_activityArchive:1}),now]);for(const e of entities)await db.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',[owner,e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);}
const input=(direction,eventId)=>({personId:'sensor',direction,eventId,at:now});
const canon=s=>{const clone=structuredClone(s);clone.events=clone.events.map(e=>({...e,id:'event'}));clone.visits=clone.visits.map(v=>({...v,id:'visit'}));return clone;};
test('device slice persisted in/out state equals full reducer, retains unrelated rows, and duplicate/replay checks remain',async()=>{
 const old=process.env.GYMOS_DEVICE_EVENT_READS;process.env.GYMOS_DEVICE_EVENT_READS='1';try{
 const s=fixture();await seed('DF',s);await seed('DS',s);
 for(const [direction,eventId] of [['in','event0001'],['out','event0002']]){
  const data=input(direction,eventId),full=await readEntitySpace('DF');let k=0;const id=()=>['shared-visit-id','shared-event-id'][k++]??'shared-other';const expected=ingestDeviceEvent(full.state,'main','device',data,now,id);assert.equal(await persistSpace('DF',full,expected.state),true);
  k=0;const actual=await tryDeviceSlice(be,{owner:'DS',branch:'main',device:'device',input:data,now,newId:id});assert.equal(actual,false);
  assert.deepEqual(canon((await readEntitySpace('DS')).state),canon((await readEntitySpace('DF')).state));
  assert.equal(await tryDeviceSlice(be,{owner:'DS',branch:'main',device:'device',input:data,now,newId:id}),true);
  await assert.rejects(tryDeviceSlice(be,{owner:'DS',branch:'main',device:'device',input:{...data,direction:direction==='in'?'out':'in'},now,newId:id}),/eventConflict/);
 }
 }finally{if(old===undefined)delete process.env.GYMOS_DEVICE_EVENT_READS;else process.env.GYMOS_DEVICE_EVENT_READS=old;}
});
test('disabled flag, unresolved mapping, absent counters or racing revision refuse partial mutation',async()=>{
 const s=fixture();await seed('DE',s);const q={owner:'DE',branch:'main',device:'device',input:input('in','event0003'),now,newId:newid};delete process.env.GYMOS_DEVICE_EVENT_READS;assert.equal(await tryDeviceSlice(be,q),null);process.env.GYMOS_DEVICE_EVENT_READS='1';
 assert.equal(await tryDeviceSlice(be,{...q,input:{...q.input,personId:'unknown'}}),null);
 const noCounters={...be,counters:async()=>null};assert.equal(await tryDeviceSlice(noCounters,q),null);
 let metaReads=0;const racing={...be,meta:async o=>{const m=await be.meta(o);return ++metaReads>1?{...m,revision:m.revision+1}:m;}};assert.equal(await tryDeviceSlice(racing,q),null);
 const before=(await readEntitySpace('DE')).revision;assert.equal(before,1);delete process.env.GYMOS_DEVICE_EVENT_READS;await db.close();
});
