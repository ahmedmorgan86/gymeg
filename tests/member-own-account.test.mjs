import {test} from 'node:test';import assert from 'node:assert/strict';import {registerHooks} from 'node:module';import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const db=globalThis.__ownDb=await bootstrapDb();
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}},load(url,c,n){
 if(url.endsWith('/app/lib/read-transaction.ts'))return{format:'module',shortCircuit:true,source:`export const readDeadlineScope=deadline=>(o,work)=>globalThis.__ownDb.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);return work(c);});`};
 if(url.endsWith('/app/lib/member-code-session.ts'))return{format:'module',shortCircuit:true,source:'export const codeMemberIdentity=async()=>globalThis.__ownIdentity;'};
 if(url.endsWith('/app/lib/database.ts'))return{format:'module',shortCircuit:true,source:`export const getPool=()=>{throw Error("unscoped DB")};export const withScope=(o,work)=>globalThis.__ownDb.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[o]);return work(c);});`};
 if(url.endsWith('/app/lib/server-workspace.ts'))return{format:'module',shortCircuit:true,source:'export const reply=(data,status=200)=>Response.json(data,{status});'};
 if(url.endsWith('/app/lib/firestore-db.ts'))return{format:'module',shortCircuit:true,source:'export const isFirestorePersistence=()=>false;export const getFirestoreDb=()=>{throw Error("no firestore")};'};
 if(url.endsWith('/app/lib/commercial.ts'))return{format:'module',shortCircuit:true,source:'export const normalizeLicense=x=>x;'};return n(url,c);
}});
const {GET}=await import('../app/api/member-account-detail/route.ts');const {readOwnMemberAccount}=await import('../app/lib/member-own-account.ts');const {withScope}=await import('../app/lib/database.ts');const {splitState}=await import('../app/lib/entity-state.ts');const {fixture}=await import('./member-summary-fixture.mjs');const {memberCredit,invoiceOutstanding}=await import('../app/lib/member-ledger.ts');
async function seed(owner,s){const {metadata,entities}=splitState(s);await db.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,1,$3)',[owner,JSON.stringify(metadata),'x']);for(const e of entities)await db.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',[owner,e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);}
const s=fixture();for(const v of s.visits)if(!v.leftAt)v.leftAt=v.at;s.members.push({...s.members[0],id:'5'});s.payments.push({id:'pforeignbranch',member:'plain',branch:'b',minor:100000000,voided:false,day:'2026-03-15'},{id:'pforeignmember',member:'quota',branch:'a',minor:12345,day:'2026-03-15'},{id:'numeric',member:5,branch:'a',minor:99999999,day:'2026-03-15'});s.payments[0].creditable=true;s.invoices.push({id:'crossallocation',member:'quota',branch:'b',total:20,allocations:[{payment:'p1',minor:20}],voided:false},{id:'iforeignbranch',member:'plain',branch:'b',total:99999999,allocations:[],voided:false},{id:'ivoid',member:'plain',branch:'a',total:50000,allocations:[],voided:true});await seed('OWN',s);await seed('OTHER',s);
const identity=()=>({owner_id:'OWN',member_id:'plain',branch:'a',pin_must_change:false});
const req=()=>new Request('https://gym.test/api/member-account-detail?member=quota&owner=OTHER&branch=b');
test('defaultOFF, auth and mandatory PIN-change gates precede any disclosure',async()=>{
 delete process.env.GYMOS_MEMBER_ACCOUNT_READS;assert.equal((await GET(req())).status,404);process.env.GYMOS_MEMBER_ACCOUNT_READS='1';globalThis.__ownIdentity=null;assert.equal((await GET(req())).status,401);globalThis.__ownIdentity={...identity(),pin_must_change:true};assert.equal((await GET(req())).status,403);
});
test('browser-selected identities ignored; own branch ledger equals legacy and contains no foreign rows or member private fields',async()=>{
 globalThis.__ownIdentity=identity();const r=await GET(req());assert.equal(r.status,200);const j=await r.json();assert.equal(j.memberId,'plain');assert.equal(j.branch,'a');assert.equal(j.credit,memberCredit(s,'plain','a'));
 const inv=s.invoices.filter(i=>i.member==='plain'&&i.branch==='a');assert.deepEqual(j.invoices,inv);assert.equal(j.outstanding,inv.filter(i=>!i.voided).reduce((n,i)=>n+invoiceOutstanding(s,i),0));assert.deepEqual(j.payments,s.payments.filter(p=>p.member==='plain'&&p.branch==='a'));
 assert.equal('member' in j,false);assert.equal(JSON.stringify(j).includes('pforeign'),false);assert.equal('settings' in j,false);
 const numeric=await readOwnMemberAccount(withScope,{owner:'OWN',member:'5',branch:'a'});assert.equal(numeric.status,'ok');assert.deepEqual(numeric.payments,[]);
});
test('inactive/foreign/malformed member identity is not linked; concurrent version changes refuse results',async()=>{
 globalThis.__ownIdentity={...identity(),branch:'b'};assert.equal((await GET(req())).status,404);
 await db.query("UPDATE gymos.gym_entities SET payload=jsonb_set(payload,'{archived}','true') WHERE owner_id='OWN' AND collection='members' AND entity_id='plain'");globalThis.__ownIdentity=identity();assert.equal((await GET(req())).status,404);
 globalThis.__ownIdentity={...identity(),member_id:'quota'};let reads=0;
 const race=(o,work)=>withScope(o,c=>work({query:async(sql,p)=>{const r=await c.query(sql,p);if(sql.startsWith('SELECT version')&&++reads===2)r.rows[0].version=String(BigInt(r.rows[0].version)+1n);return r;}}));
 assert.deepEqual(await readOwnMemberAccount(race,{owner:'OWN',member:'quota',branch:'a'}),{status:'unavailable',reason:'changed'});
 await db.close();delete process.env.GYMOS_MEMBER_ACCOUNT_READS;
});
