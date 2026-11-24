import {test,after} from 'node:test';import assert from 'node:assert/strict';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
import {POST} from '../app/api/member-barcode/route.ts';
import {emptyState} from '../app/lib/domain.ts';
import {splitState} from '../app/lib/entity-state.ts';
const db=globalThis.__entityDb=await bootstrapDb();
after(()=>db.close());
const owner='owner-a';
async function seed(members){
  await db.query('DELETE FROM gymos.gym_entities WHERE owner_id=$1',[owner]);await db.query('DELETE FROM gymos.gym_states WHERE user_id=$1',[owner]);
  const s=emptyState();s.branches=[{id:'main',name:'Main'},{id:'other',name:'Other'}];s.members=members;
  const {metadata,entities}=splitState(s);
  await db.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,1,$3)',[owner,JSON.stringify(metadata),new Date().toISOString()]);
  for(const e of entities)await db.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',[owner,e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);
}
function ctx(extra={}){globalThis.__qaContext={owner,tenantId:'tenant-a',role:'owner',branches:null,license:{mode:'perpetual',status:'active',starts_at:'2026-01-01T00:00:00Z',ends_at:null,maintenance_until:null},user:{userId:'staff'},...extra};}
const req=body=>new Request('https://example.test/api/member-barcode',{method:'POST',headers:{origin:'https://example.test','X-GymOS-Tenant':'tenant-a'},body:JSON.stringify(body)});
const base=(id,x={})=>({id,name:'Test Member',phone:'01000000000',branch:'main',joined:'2026-01-01',expires:'2026-12-31',archived:false,demo:false,...x});
test('entity-layout club: cross-branch, archived, reception role and duplicate-card checks see real members',async()=>{
  ctx();
  await seed([base('old-1'),base('old-2',{branch:'other'}),base('old-3',{archived:true}),base('old-4',{card:'12345678-0001'})]);
  assert.equal((await POST(req({member:'old-1',branch:'main'}))).status,200,'existing member in own branch replaces card');
  assert.equal((await POST(req({member:'old-2',branch:'main'}))).status,403,'existing member of another branch is refused');
  assert.equal((await POST(req({member:'old-3',branch:'main'}))).status,400,'archived member is inactive');
  assert.equal((await POST(req({member:'old-1',branch:'main',code:'12345678-0001'}))).status,409,'a card held by another member is cardUsed');
  ctx({role:'reception'});
  assert.equal((await POST(req({member:'old-1',branch:'main'}))).status,403,'reception without card.replace grant cannot replace a card for an existing member');
});
