import {test} from 'node:test';
import {writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}}});
const {splitState}=await import('../app/lib/entity-state.ts');
const {fixture}=await import('./member-summary-fixture.mjs');
const {dueMessages}=await import('../app/lib/whatsapp.ts');
const {readWhatsAppJobPage,WHATSAPP_MEMBER_PAGE}=await import('../app/lib/whatsapp-job-page.ts');
const db=await bootstrapDb();
const queries=[];
const scope=(owner,work)=>db.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);return work({query:async(sql,p)=>{queries.push({sql,p});assert.doesNotMatch(sql,/INSERT|UPDATE|DELETE|messaging_decrypt|whatsapp_outbox/i);return c.query(sql,p);}});});
async function seed(owner,s){const {metadata,entities}=splitState(s);await db.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,1,$3)',[owner,JSON.stringify(metadata),'x']);for(const e of entities)await db.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',[owner,e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);}
const now='2026-03-15T12:00:00.000Z';
const rule={id:'6bbba33d-e170-4cd3-a14e-cc503d477457',branch:'a',name:'Test',kind:'absence',enabled:true,time:'09:00',template:'test',language:'ar',offset:2,date:'2026-03-15',parameters:['{name}','{gym}','{expires}'],createdAt:'2025-12-25T00:00:00Z'};
const s=fixture();s.members=[];s.visits=[];s.payments=[];s.invoices=[];
for(let i=0;i<577;i++)s.members.push({id:'m'+i,name:'Member '+i,phone:i%17===0?'invalid':'+201000000001',branch:i%19===0?'b':'a',joined:i%5===0?'2026-03-14':'2026-01-01',expires:i%7===0?'2026-03-13':i%7===1?'2026-03-17':'2026-12-31',health:{birthDate:i%3===0?'2000-03-15':'2000-02-01'},whatsapp:{enabled:i%11!==0},demo:i%13===0,archived:i%23===0});
let n=0;for(let i=0;i<s.members.length;i++)for(const [day,branch] of [['2025-12-31','a'],['2026-03-05','a'],['2026-03-13',i%2?'a':'b'],['2027-01-01','a']])s.visits.push({id:'v'+n++,member:'m'+i,branch,day,at:day+'T10:00:00.000Z',leftAt:day+'T11:00:00.000Z',method:'x'});
await seed('W1',s);await seed('W2',{...s,members:[{...s.members[1],name:'OTHER OWNER'}],visits:[]});
async function all(r,at=now){let after,version,out=[];do{const p=await readWhatsAppJobPage(scope,{owner:'W1',rule:r,now:at,after,version});assert.equal(p.status,'ok');assert.ok(p.jobs.length<=WHATSAPP_MEMBER_PAGE);out.push(...p.jobs);after=p.next;version=p.version;}while(after);return out;}
test('paged automatic WhatsApp inputs equal legacy dueMessages for every rule; no unrelated reads or effects',async()=>{
 for(const kind of ['welcome','policy','birthday','occasion','absence','renewal','expired'])for(const at of [now,'2026-03-15T00:00:00.000Z','2026-03-16T12:00:00.000Z']){
  const r={...rule,kind};assert.deepEqual(await all(r,at),dueMessages(s,r,at),kind+at);
 }
 const captured=queries.find(q=>q.sql.includes('LATERAL'));
 const lit=v=>Array.isArray(v)?'ARRAY['+v.map(lit).join(',')+']::text[]':"'"+String(v).replaceAll("'","''")+"'";
 writeFileSync('/tmp/whatsapp-generated-plan.sql','-- Captured from real selector test, synthetic values only. HELD query, not applied to live database.\nEXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) '+captured.sql.replace(/\$(\d+)/g,(_,n)=>lit(captured.p[Number(n)-1]))+';\n');
 assert.ok(queries.some(q=>q.sql.includes('LATERAL')));assert.ok(queries.filter(q=>q.sql.includes('LATERAL')).every(q=>q.p[2].length<=250));
 assert.ok(queries.every(q=>!q.sql.includes('gym_photos')));assert.ok(queries.filter(q=>q.sql.includes('gym_entities')).every(q=>/collection='(members|visits)'/.test(q.sql)));
 const p=await readWhatsAppJobPage(scope,{owner:'W1',rule,now,memberId:'m1'});assert.equal(p.status,'ok');assert.deepEqual(p.jobs,dueMessages(s,rule,now).filter(j=>j.member==='m1'));
 const other=await readWhatsAppJobPage(scope,{owner:'W2',rule,now,memberId:'m1'});assert.equal(other.status,'ok');assert.ok(other.jobs.every(j=>j.parameters[0]==='OTHER OWNER'));
 const v=p.version;await db.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{whatsapp,enabled}','false') WHERE owner_id='W1' AND collection='members' AND entity_id='m1'");
 assert.deepEqual(await readWhatsAppJobPage(scope,{owner:'W1',rule,now,version:v}),{status:'fallback',reason:'version'});
 const fresh=await readWhatsAppJobPage(scope,{owner:'W1',rule,now,memberId:'m1'});assert.equal(fresh.status,'ok');assert.deepEqual(fresh.jobs,[]);
});
test('odd visit day refuses fast path; nonstring legacy member keys are not coerced; raced versions refuse',async()=>{
 await db.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{day}','\"2026-3-9\"') WHERE owner_id='W1' AND entity_id='v8'");
 assert.deepEqual(await readWhatsAppJobPage(scope,{owner:'W1',rule,now,memberId:'m2'}),{status:'fallback',reason:'visit-day'});
 const full={...s,members:[{...s.members[2],id:'1'}],visits:[{id:'vn',member:1,branch:'a',day:'2026-03-15',at:now,leftAt:now,method:'x'}]};await seed('WN',full);
 const numeric=await readWhatsAppJobPage(scope,{owner:'WN',rule,now});assert.equal(numeric.status,'ok');assert.deepEqual(numeric.jobs,dueMessages(full,rule,now));
 let reads=0;const racing=async(o,work)=>scope(o,c=>work({query:async(sql,p)=>{const r=await c.query(sql,p);if(sql.startsWith('SELECT version')&&++reads===2)r.rows[0].version=String(BigInt(r.rows[0].version)+1n);return r;}}));
 assert.deepEqual(await readWhatsAppJobPage(racing,{owner:'W1',rule:{...rule,kind:'birthday'},now,memberId:'m2'}),{status:'fallback',reason:'changed'});
});
test('missing owner/layout/version and DB budget are explicit and never cause writes',async()=>{
 assert.equal((await readWhatsAppJobPage(scope,{owner:'missing',rule,now})).status,'fallback');
 await assert.rejects(readWhatsAppJobPage(async(o,work)=>work({query:async()=>{const e=new Error('slow');e.code='57014';throw e;}}),{owner:'W1',rule,now}),e=>e.name==='ReadBudgetError');
 await db.close();
});
