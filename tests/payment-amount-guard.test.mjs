import {test} from 'node:test';import assert from 'node:assert/strict';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';

test('Direct JSON writes cannot create non-positive or fractional payment amounts',async()=>{
  const db=await bootstrapDb();
  try{
    await db.query("INSERT INTO gymos.gym_states(user_id,payload,updated_at) VALUES('owner-a',$1,'2026-11-17')",[JSON.stringify({schema:1,payments:[{id:'p1',minor:1000}],visits:[],members:[]})]);
    await assert.rejects(
      ()=>db.query("UPDATE gymos.gym_states SET payload=$1 WHERE user_id='owner-a'",[JSON.stringify({schema:1,payments:[{id:'p2',minor:-1}],visits:[],members:[]})]),
      /invalidPaymentAmount/
    );
    await assert.rejects(
      ()=>db.query("UPDATE gymos.gym_states SET payload=$1 WHERE user_id='owner-a'",[JSON.stringify({schema:1,payments:[{id:'p3',minor:1.5}],visits:[],members:[]})]),
      /invalidPaymentAmount/
    );
    await assert.rejects(
      ()=>db.query("UPDATE gymos.gym_states SET payload=$1 WHERE user_id='owner-a'",[JSON.stringify({schema:1,payments:[{id:'p4'}],visits:[],members:[]})]),
      /invalidPaymentAmount/
    );
    await db.query("UPDATE gymos.gym_states SET payload=$1 WHERE user_id='owner-a'",[JSON.stringify({schema:1,payments:[{id:'p5',minor:2000}],visits:[],members:[]})]);
  }finally{await db.close();}
});
