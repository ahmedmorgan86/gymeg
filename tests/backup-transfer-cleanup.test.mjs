import {test} from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const migration=readFileSync(new URL('../supabase/migrations/20261117134000_backup_transfer_expiry_cleanup.sql',import.meta.url),'utf8');
const setup=`CREATE SCHEMA gymos;CREATE ROLE gymos_app;CREATE ROLE anon;CREATE ROLE authenticated;GRANT USAGE ON SCHEMA gymos TO gymos_app;
CREATE TABLE gymos.gym_backup_transfers(
 id uuid PRIMARY KEY,owner_id text NOT NULL,actor_id text NOT NULL,mode text NOT NULL CHECK(mode IN ('upload','download')),
 bytes integer NOT NULL CHECK(bytes BETWEEN 1 AND 67108864),digest text NOT NULL CHECK(digest ~ '^[a-f0-9]{64}$'),
 chunks jsonb NOT NULL DEFAULT '{}'::jsonb,expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes'
);
ALTER TABLE gymos.gym_backup_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE gymos.gym_backup_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY backup_transfer_scope ON gymos.gym_backup_transfers TO gymos_app
 USING(owner_id=current_setting('app.gym_owner',true) AND actor_id=current_setting('app.gym_actor',true))
 WITH CHECK(owner_id=current_setting('app.gym_owner',true) AND actor_id=current_setting('app.gym_actor',true));
GRANT SELECT,INSERT,UPDATE,DELETE ON gymos.gym_backup_transfers TO gymos_app;`;

test('Expired backup transfer rows are removed globally while live rows and RLS remain intact',async()=>{
  const db=new PGlite();
  try{
    await db.exec(setup);
    await db.exec(migration);
    await db.query("INSERT INTO gymos.gym_backup_transfers(id,owner_id,actor_id,mode,bytes,digest,expires_at) VALUES('11111111-1111-4111-8111-111111111111','owner-a','actor-a','upload',1,$1,now()-interval '1 minute')",['0'.repeat(64)]);
    await db.query("INSERT INTO gymos.gym_backup_transfers(id,owner_id,actor_id,mode,bytes,digest,expires_at) VALUES('22222222-2222-4222-8222-222222222222','owner-b','actor-b','upload',1,$1,now()-interval '1 minute')",['0'.repeat(64)]);
    await db.query("INSERT INTO gymos.gym_backup_transfers(id,owner_id,actor_id,mode,bytes,digest) VALUES('33333333-3333-4333-8333-333333333333','owner-b','actor-b','upload',1,$1)",['0'.repeat(64)]);
    await db.exec("SET ROLE gymos_app;SELECT set_config('app.gym_owner','owner-a',false),set_config('app.gym_actor','actor-a',false)");
    assert.equal((await db.query('SELECT gymos.cleanup_expired_backup_transfers() AS n')).rows[0].n,2);
    await db.exec("SELECT set_config('app.gym_owner','owner-b',false),set_config('app.gym_actor','actor-b',false)");
    assert.equal((await db.query('SELECT count(*)::int AS n FROM gymos.gym_backup_transfers')).rows[0].n,1);
    const blocked=await db.query("DELETE FROM gymos.gym_backup_transfers WHERE owner_id='owner-a' RETURNING id");
    assert.equal(blocked.rowCount,0);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM gymos.gym_backup_transfers WHERE owner_id='owner-b'")).rows[0].n,1);
    await db.exec('RESET ROLE');
    assert.equal((await db.query("SELECT id FROM gymos.gym_backup_transfers")).rows[0].id,'33333333-3333-4333-8333-333333333333');
    await db.exec(migration);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM gymos.gym_backup_transfers')).rows[0].n,1);
  }finally{await db.close();}
});
