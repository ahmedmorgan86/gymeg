import {test} from 'node:test';import assert from 'node:assert/strict';
import {bootstrapDb,readFile} from './db-bootstrap-helpers.mjs';

test('A normalized transfer reference is globally unique across currencies and statuses',async()=>{
  const db=await bootstrapDb();
  try{
    await db.query("INSERT INTO gymos.tenants(id,storage_key,name,created_by) VALUES('t1','owner-a','A','u1'),('t2','owner-b','B','u2')");
    await db.query("INSERT INTO gymos.activation_requests(id,tenant_id,user_id,plan_id,mode,status,entitlements,currency,transfer_ref) VALUES('req1','t1','u1','legacy','perpetual','approved','{}','EGP','REF-1')");
    await assert.rejects(
      ()=>db.query("INSERT INTO gymos.activation_requests(id,tenant_id,user_id,plan_id,mode,status,entitlements,currency,transfer_ref) VALUES('req2','t2','u2','legacy','perpetual','pending_review','{}','USD',' ref-1 ')"),
      /activation_requests_unique_transfer|duplicate key/i
    );
    await db.query("INSERT INTO gymos.activation_requests(id,tenant_id,user_id,plan_id,mode,status,entitlements,currency,transfer_ref) VALUES('req3','t2','u2','legacy','perpetual','pending_review','{}','USD','REF-2')");
    const migration=readFile('supabase/migrations/20261117136000_global_transfer_reference.sql');
    assert.match(migration,/review before making references globally unique/);
  }finally{await db.close();}
});
