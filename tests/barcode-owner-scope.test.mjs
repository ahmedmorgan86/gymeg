import {test} from 'node:test';import assert from 'node:assert/strict';
import {bootstrapDb,readFile,stripUnavailableExtensions} from './db-bootstrap-helpers.mjs';

const unified='supabase/migrations/20261026224250_unified_member_console.sql';
const beforeUnified='20261023221405_member_default_pin_change.sql';

test('Two clubs may use the same barcode; a club may not reuse it internally',async()=>{
  const db=await bootstrapDb({through:beforeUnified});
  try{
    await db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,branch,payload) VALUES('owner-a','members','m1','main',$1)",[JSON.stringify({name:'A',card:'CARD-1',cards:[]})]);
    await db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,branch,payload) VALUES('owner-b','members','m2','main',$1)",[JSON.stringify({name:'B',card:'CARD-1',cards:[]})]);
    await db.exec(stripUnavailableExtensions(readFile(unified)));
    const cards=(await db.query('SELECT owner_id,code FROM gymos.membership_cards ORDER BY owner_id')).rows;
    assert.deepEqual(cards,[{owner_id:'owner-a',code:'CARD-1'},{owner_id:'owner-b',code:'CARD-1'}]);
    const key=(await db.query("SELECT cardinality(conkey) AS n FROM pg_constraint WHERE conrelid='gymos.membership_cards'::regclass AND conname='membership_cards_pkey'")).rows[0].n;
    assert.equal(key,2);
    await assert.rejects(
      ()=>db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,branch,payload) VALUES('owner-a','members','m3','main',$1)",[JSON.stringify({name:'C',card:'CARD-1',cards:[]})]),
      /barcode already used|barcode ownership conflict/i
    );
  }finally{await db.close();}
});

test('Duplicate open attendance sessions abort the migration with an explicit preflight error',async()=>{
  const db=await bootstrapDb({through:beforeUnified});
  try{
    await db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,branch,payload) VALUES('owner-a','members','m1','main',$1)",[JSON.stringify({name:'A',cards:[]})]);
    await db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,branch,payload) VALUES('owner-a','visits','v1','main',$1)",[JSON.stringify({member:'m1',at:'2026-11-17T10:00:00Z'})]);
    await db.query("INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,branch,payload) VALUES('owner-a','visits','v2','main',$1)",[JSON.stringify({member:'m1',at:'2026-11-17T11:00:00Z'})]);
    await assert.rejects(
      ()=>db.exec(stripUnavailableExtensions(readFile(unified))),
      /Duplicate open attendance sessions: resolve before migrating/
    );
  }finally{await db.close();}
});
