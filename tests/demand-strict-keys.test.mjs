import {test} from 'node:test';import assert from 'node:assert/strict';import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const db=await bootstrapDb();
test('strict generated member/day/clock keys preserve malformed/null/oversized source data and follow writes',async()=>{
 await db.query("INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES('KEYS','{}',1,'x')");
 const cases=[
  {member:'1',day:'2026-03-15',at:'2026-03-15T10:00:00.000Z'},
  {member:1,day:20260315,at:'2026-02-31T10:00:00.000Z'},
  {member:null,day:'2026-3-15',at:'2026-03-15T10:00:00.000Z',activeAt:null},
  {member:'huge'.repeat(10000),day:'x'.repeat(40000),at:'x'.repeat(40000)},
  {member:'m',day:'2026-03-15',at:'2026-03-15T10:00:00.000Z',activeAt:false},
  {member:'m',day:'2026-03-15',at:'2026-03-15T10:00:00.000Z',activeAt:'2026-03-15T11:00:00.000Z'},
  {member:'m',day:'2026-02-31',at:'2024-02-29T10:00:00.000Z'},
 ];
 for(let i=0;i<cases.length;i++)await db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES('KEYS','visits',$1,$2,'main',$3)",['k'+i,i,JSON.stringify({...cases[i],leftAt:'closed'})]);
 const rows=(await db.query("SELECT entity_id,payload,demand_member_hash,demand_visit_day,demand_visit_clock FROM gymos.gym_entities WHERE owner_id='KEYS' ORDER BY position")).rows;
 for(let i=0;i<cases.length;i++){const r=rows[i],p=cases[i];assert.deepEqual(r.payload,{...p,leftAt:'closed'});assert.equal(r.demand_member_hash,typeof p.member==='string'?(await db.query('SELECT md5($1) AS h',[p.member])).rows[0].h:null);assert.equal(r.demand_visit_day,typeof p.day==='string'&&/^\d{4}-\d\d-\d\d$/.test(p.day)?p.day:null);}
 assert.deepEqual(rows.map(r=>r.demand_visit_clock),['2026-03-15T10:00:00.000Z',null,'2026-03-15T10:00:00.000Z',null,null,'2026-03-15T11:00:00.000Z','2024-02-29T10:00:00.000Z']);
 await db.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{member}','\"updated\"') WHERE owner_id='KEYS' AND entity_id='k0'");assert.equal((await db.query("SELECT demand_member_hash=md5('updated') AS ok FROM gymos.gym_entities WHERE owner_id='KEYS' AND entity_id='k0'")).rows[0].ok,true);
 const before=(await db.query("SELECT entity_id,payload FROM gymos.gym_entities WHERE owner_id='KEYS' ORDER BY position")).rows;
 await db.exec('DROP INDEX gymos.gym_entities_demand_member_rows;DROP INDEX gymos.gym_entities_demand_visit_day;DROP INDEX gymos.gym_entities_demand_visit_clock;ALTER TABLE gymos.gym_entities DROP COLUMN demand_visit_clock,DROP COLUMN demand_visit_day,DROP COLUMN demand_member_hash;');
 assert.deepEqual((await db.query("SELECT entity_id,payload FROM gymos.gym_entities WHERE owner_id='KEYS' ORDER BY position")).rows,before);
 await db.close();
});
