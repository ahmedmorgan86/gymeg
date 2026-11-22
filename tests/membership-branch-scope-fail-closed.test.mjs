import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';

// Full-chain PGlite proof for 20261122090000: malformed non-owner branch
// grants fail closed to an empty array; owner NULL (all branches) is kept.
test('non-owner malformed branch scope fails closed, owner stays unrestricted',async()=>{
 const db=await bootstrapDb();
 try{
  await db.query('BEGIN');
  await db.query("INSERT INTO gymos.tenants(id,storage_key,name,created_by) VALUES('bs-t','bs-owner','Synthetic','actor')");
  await db.query("INSERT INTO gymos.tenant_licenses(tenant_id,plan_id,mode,status,starts_at,limits) SELECT 'bs-t',id,'perpetual','active',now(),'{\"staff\":50}'::jsonb FROM gymos.commercial_plans LIMIT 1");
  const cases={'null':'null','false':'false','zero':'0','object':'{"a":1}','string':'"main"','mixed':'["main",1]','garbage':'not json','nested':'[["main"]]'};
  let i=0;
  for(const [name,raw] of Object.entries(cases)){
   await db.query("INSERT INTO gymos.gym_access(owner_id,user_id,name,role,branches) VALUES('bs-owner',$1,'S','manager',$2)",['u-'+name,raw]);i++;
   const r=(await db.query("SELECT branches FROM gymos.tenant_memberships WHERE tenant_id='bs-t' AND user_id=$1",['u-'+name])).rows[0];
   assert.deepEqual(r.branches,[],name+' must fail closed to []');
  }
  await db.query("INSERT INTO gymos.gym_access(owner_id,user_id,name,role,branches) VALUES('bs-owner','u-ok','S','reception','[\"main\",\"b2\"]')");
  assert.deepEqual((await db.query("SELECT branches FROM gymos.tenant_memberships WHERE user_id='u-ok'")).rows[0].branches,['main','b2']);
  // Direct writes (any writer) are guarded by the trigger too.
  await db.query("UPDATE gymos.tenant_memberships SET branches='null'::jsonb WHERE user_id='u-ok'");
  assert.deepEqual((await db.query("SELECT branches FROM gymos.tenant_memberships WHERE user_id='u-ok'")).rows[0].branches,[]);
  // Owner semantics preserved: NULL all-branch scope.
  await db.query("INSERT INTO gymos.tenant_memberships(tenant_id,user_id,role,name) VALUES('bs-t','u-owner','owner','O')");
  assert.equal((await db.query("SELECT branches FROM gymos.tenant_memberships WHERE user_id='u-owner'")).rows[0].branches,null);
  // Promoting to owner keeps NULL, demoting to manager with NULL fails closed.
  await db.query("UPDATE gymos.tenant_memberships SET role='manager' WHERE user_id='u-owner'");
  assert.deepEqual((await db.query("SELECT branches FROM gymos.tenant_memberships WHERE user_id='u-owner'")).rows[0].branches,[]);
  await db.query("UPDATE gymos.tenant_memberships SET role='owner',branches=NULL WHERE user_id='u-owner'");
  assert.equal((await db.query("SELECT branches FROM gymos.tenant_memberships WHERE user_id='u-owner'")).rows[0].branches,null);
  assert.ok(i>=8);
  await db.query('ROLLBACK');
 }finally{await db.close();}
});
