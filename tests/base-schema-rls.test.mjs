import {test} from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const base=readFileSync(new URL('../db/postgres.sql',import.meta.url),'utf8');
const setup='CREATE ROLE gymos_app;CREATE ROLE anon;CREATE ROLE authenticated;';

test('Base bootstrap is replay-safe and scopes every partition row to its owner',async()=>{
  const db=new PGlite();
  try{
    await db.exec(setup);
    await db.exec(base);
    await db.exec(base);
    await db.query("INSERT INTO gymos.gym_states(user_id,payload,updated_at) VALUES('owner-a','{}','2026-01-01')");
    await db.query("INSERT INTO gymos.gym_states(user_id,payload,updated_at) VALUES('owner-b','{}','2026-01-01')");
    await db.query("INSERT INTO gymos.gym_access(owner_id,user_id,name,role,branches) VALUES('owner-a','staff','A','manager','[\"main\"]')");
    await db.query("INSERT INTO gymos.gym_access(owner_id,user_id,name,role,branches) VALUES('owner-b','staff','B','manager','[\"main\"]')");
    await db.query("INSERT INTO gymos.gym_invites(token_hash,owner_id,role,branches,expires_at) VALUES($1,'owner-a','manager','[\"main\"]','2027-01-01')",['a'.repeat(64)]);
    await db.query("INSERT INTO gymos.gym_invites(token_hash,owner_id,role,branches,expires_at) VALUES($1,'owner-b','manager','[\"main\"]','2027-01-01')",['b'.repeat(64)]);
    await db.query("INSERT INTO gymos.gym_recovery(id,owner_id,payload,created_at) VALUES('ra','owner-a','{}','2026-01-01')");
    await db.query("INSERT INTO gymos.gym_recovery(id,owner_id,payload,created_at) VALUES('rb','owner-b','{}','2026-01-01')");
    await db.exec("SET ROLE gymos_app;SELECT set_config('app.gym_owner','owner-a',false)");
    for(const table of ['gym_states','gym_access','gym_recovery'])assert.equal((await db.query(`SELECT count(*)::int AS n FROM gymos.${table}`)).rows[0].n,1,table);
    assert.equal((await db.query('SELECT owner_id FROM gymos.gym_invites')).rows[0].owner_id,'owner-a');
    await assert.rejects(()=>db.query("INSERT INTO gymos.gym_access(owner_id,user_id,name,role,branches) VALUES('owner-b','evil','E','manager','[]')"));
    await db.query("SELECT set_config('app.invite_token',$1,false)",['b'.repeat(64)]);
    assert.deepEqual((await db.query('SELECT owner_id FROM gymos.gym_invites ORDER BY owner_id')).rows.map(r=>r.owner_id),['owner-a','owner-b']);
    await db.exec('RESET ROLE');
  }finally{await db.close();}
});
