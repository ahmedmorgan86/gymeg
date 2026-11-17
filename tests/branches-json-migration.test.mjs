import {test} from 'node:test';import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {localExtensionStubs,baseFiles,readFile,stripUnavailableExtensions} from './db-bootstrap-helpers.mjs';

test('Malformed legacy branch grants migrate to an empty scope, not unrestricted access',async()=>{
  const db=new PGlite();
  try{
    await db.exec(localExtensionStubs);
    for(const file of baseFiles)await db.exec(readFile(file));
    await db.query("INSERT INTO gymos.gym_states(user_id,payload,updated_at) VALUES('legacy-owner',$1,'2026-11-17')",[JSON.stringify({branches:[{id:'main',name:'Main'}]})]);
    await db.query("INSERT INTO gymos.gym_access(owner_id,user_id,name,role,branches) VALUES('legacy-owner','legacy-manager','Legacy','manager','main')");
    await db.query("INSERT INTO gymos.gym_access(owner_id,user_id,name,role,branches) VALUES('legacy-owner','valid-manager','Valid','manager',$1)",[JSON.stringify(['main'])]);
    await db.exec(stripUnavailableExtensions(readFile('supabase/migrations/20261019183227_commercial_multiclub.sql')));
    const rows=(await db.query("SELECT m.user_id,m.branches FROM gymos.tenant_memberships m JOIN gymos.tenants t ON t.id=m.tenant_id WHERE t.storage_key='legacy-owner' ORDER BY m.user_id")).rows;
    const byId=Object.fromEntries(rows.map(row=>[row.user_id,row.branches]));
    assert.deepEqual(byId['legacy-manager'],[],'malformed legacy scope must fail closed');
    assert.deepEqual(byId['valid-manager'],['main'],'valid legacy scope must be preserved');
    assert.equal(byId['legacy-owner'],null,'owner scope remains unrestricted');
  }finally{await db.close();}
});
