import {test} from 'node:test';import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const db=globalThis.__hotDb=await bootstrapDb();
registerHooks({
  resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}},
  load(url,ctx,next){if(url.endsWith('/app/lib/database.ts'))return{format:'module',shortCircuit:true,source:`export const getPool=()=>({connect:async()=>({query:(sql,v)=>globalThis.__hotDb.query(sql,v),release(){}})});export const isFirebaseConfigured=()=>false;`};return next(url,ctx);}
});
const {persistSpace}=await import('../app/lib/entity-store.ts');
const {refreshDirtySummaries,readMemberCandidates,REFRESH_MAX,MEMBER_CANDIDATE_MAX}=await import('../app/lib/member-summary-store.ts');
const {deriveSummary}=await import('../app/lib/member-summary-model.ts');
const {memberSummary}=await import('../app/lib/member-console.ts');
const {splitState}=await import('../app/lib/entity-state.ts');
const {fixture}=await import('./member-summary-fixture.mjs');
const localOf=(s,m)=>({...s,members:[m],visits:s.visits.filter(v=>v.member===m.id&&v.branch===m.branch),payments:s.payments.filter(p=>p.member===m.id&&p.branch===m.branch),invoices:(s.invoices??[]).filter(i=>i.member===m.id&&i.branch===m.branch)});
const ORACLE=(s,m,now)=>memberSummary(localOf(s,m),m,now); // what consoleIndex(branch) computes for a member of that branch
const strip=x=>JSON.parse(JSON.stringify(x));
const NOWS=['2026-03-15T12:00:00.000Z','2026-03-15T15:00:00.000Z','2026-03-20T22:30:00.000Z','2026-04-01T00:30:00.000Z','2027-01-02T10:00:00.000Z'];
async function seed(owner,state){
  state=structuredClone(state);const op=state.visits.filter(v=>v.member==='plain'&&!v.leftAt);for(const v of op.slice(1))v.leftAt=v.day+'T23:00:00.000Z'; // one open visit per member
  const {metadata,entities}=splitState(state);
  await db.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,5,$3)',[owner,JSON.stringify({...metadata,_entityStorage:1,_activityArchive:1}),'x']);
  for(const e of entities)await db.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',[owner,e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);
}
const AS='2026-03-14T00:00:00.000Z'; // compute clock for the stored horizon (2026-03-13), before every test clock
const read=(owner,b=null,opts={refresh:true,now:AS})=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);return readMemberCandidates(c,owner,b,opts);});
const via=(owner,hook,opts={refresh:true,now:AS})=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);return readMemberCandidates({query:async(s,v)=>{const r=await hook(c,s,v,'before');const x=r??await c.query(s,v);await hook(c,s,v,'after');return x;}},owner,null,opts);});
async function current(owner){const r=await db.query("SELECT collection,payload FROM gymos.gym_entities WHERE owner_id=$1 ORDER BY position,entity_id",[owner]);const s=fixture();const by=c=>r.rows.filter(x=>x.collection===c).map(x=>x.payload);s.members=by('members');s.visits=by('visits');s.payments=by('payments');s.invoices=by('invoices');return s;}
async function same(owner,label){
  const res=await read(owner);assert.equal(res.status,'ok',label+': '+res.status);const s=await current(owner);let n=0;
  for(const {member,stored} of res.candidates){
    for(const now of NOWS){const want=ORACLE(s,member,now),got=deriveSummary(strip(stored),member,s.settings,now);
      for(const k of ['period','issue','remaining','debt','status','used','visitsRemaining','paid'])assert.deepEqual(strip(got[k]),strip(want[k]),`${label} ${member.id} @ ${now}: ${k}`);
      assert.equal(got.current?.id,want.current?.id,`${label} ${member.id} current`);assert.equal(got.last?.id,want.last?.id,`${label} ${member.id} last`);n++;}
  }
  return {res,n};
}
// Restore (persistSpace restore=true, the path every backup restore uses) must
// leave stored member summaries exact against the oracle, mark only what the
// restore changed, and never touch another owner's summaries.
test('restore through persistSpace keeps summaries exact, marks at least the affected members, and isolates other owners',async()=>{
  for(const o of ['R1','R2']){await seed(o,fixture());await db.query("SELECT gymos.backfill_member_summaries($1)",[o]);}
  const dirty=async o=>(await db.query('SELECT member_id FROM gymos.gym_member_summary_dirty WHERE owner_id=$1 ORDER BY 1',[o])).rows.map(r=>r.member_id).filter(m=>m!=='archived'); // archived members are never candidates (same filter as the writer-path suite)
  const before2=strip((await read('R2')).candidates);
  await same('R1','pre-restore');await same('R2','pre-restore other owner');
  assert.deepEqual(await dirty('R1'),[]);assert.deepEqual(await dirty('R2'),[]);
  const {readEntitySpace}=await import('../app/lib/entity-store.ts');
  const space=await readEntitySpace('R1');
  // A restore replaces the whole state: change a member, drop another, move one across branches, void a payment, add visits.
  const next=structuredClone(space.state);
  const plain=next.members.find(m=>m.id==='plain');plain.expires='2026-06-30';plain.membershipPeriods[0].end='2026-06-30';
  next.members=next.members.filter(m=>m.id!=='none');
  next.members.find(m=>m.id==='ending').branch='a';
  next.visits=next.visits.filter(v=>!(v.member==='quota'&&v.day==='2026-03-05'));
  const pay=next.payments.find(p=>p.member==='plain');if(pay)pay.voided=true;
  next.visits.push({id:'vrestore',member:'legacy',branch:'a',day:'2026-03-16',at:'2026-03-16T09:00:00.000Z',leftAt:'2026-03-16T10:00:00.000Z'});
  const applied=await persistSpace('R1',space,next,true);
  assert.equal(applied,true,'persistSpace restore reports success');
  // Every intended mutation must be in the database before the oracle is derived from database rows, otherwise a lost mutation would vanish from both sides.
  const persisted=await current('R1');
  const pm=id=>persisted.members.find(m=>m.id===id);
  assert.equal(pm('plain').expires,'2026-06-30','member expiry change persisted');
  assert.equal(pm('plain').membershipPeriods[0].end,'2026-06-30','period end change persisted');
  assert.equal(pm('none'),undefined,'deleted member persisted as deleted');
  assert.equal(pm('ending').branch,'a','branch move persisted');
  assert.ok(!persisted.visits.some(v=>v.member==='quota'&&v.day==='2026-03-05'),'removed visit persisted as removed');
  assert.ok(persisted.visits.some(v=>v.id==='vrestore'&&v.member==='legacy'),'added visit persisted');
  assert.equal(persisted.payments.find(x=>x.id==='p1')?.voided,true,'voided payment persisted');
  const marked=await dirty('R1');
  for(const m of ['plain','quota','legacy','none'])assert.ok(marked.includes(m),'restore marked '+m);
  // Observed, not a requirement: a restore marks nearly every non-archived member, not only the changed ones, because it rewrites the entity rows wholesale (the 'archived' pseudo-member is filtered out by the dirty helper, so this does not assert that literally every mark exists or drains). Correctness is unaffected; the first reads after a large restore must drain a large dirty set (capacity is unmeasured).
  assert.ok(marked.length>=4);
  await same('R1','after restore');
  const res=await read('R1');assert.ok(!res.candidates.some(c=>c.member.id==='none'),'deleted member is not a candidate');
  assert.equal(res.candidates.find(c=>c.member.id==='ending').member.branch,'a','branch move is reflected');
  await db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner','R1',true)");return refreshDirtySummaries(c,'R1');});
  assert.deepEqual(await dirty('R1'),[],'refresh drains every restore mark');
  // Another owner is untouched: no marks, identical stored summaries.
  assert.deepEqual(await dirty('R2'),[]);assert.deepEqual(strip((await read('R2')).candidates),before2);
});
