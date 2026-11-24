import {test,after} from 'node:test';import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const db=globalThis.__hotDb=await bootstrapDb();
registerHooks({
  resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}},
  load(url,ctx,next){if(url.endsWith('/app/lib/database.ts'))return{format:'module',shortCircuit:true,source:`export const getPool=()=>({connect:async()=>({query:(sql,v)=>globalThis.__hotDb.query(sql,v),release(){}})});export async function withScope(owner,work){return globalThis.__hotDb.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);return work(c);});}`};return next(url,ctx);},
});
const {persistSpace,readEntitySpace}=await import('../app/lib/entity-store.ts');
const {applyOperation,emptyState}=await import('../app/lib/domain.ts');
const {splitState}=await import('../app/lib/entity-state.ts');
const {validateBackup}=await import('../app/lib/backup.ts');
const {randomUUID}=await import('node:crypto');
const NOW='2026-10-17T10:00:00Z';
const op=(s,type,extra={})=>applyOperation(s,{type,branch:'main',...extra},NOW,'QA',randomUUID);
async function seed(owner,state){const {metadata,entities}=splitState(state);await db.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,5,$3)',[owner,JSON.stringify({...metadata,_entityStorage:1,_activityArchive:1}),new Date().toISOString()]);for(const e of entities)await db.query('INSERT INTO gymos.gym_entities(owner_id,collection,entity_id,position,branch,payload) VALUES($1,$2,$3,$4,$5,$6)',[owner,e.collection,e.entity_id,e.position,e.branch,JSON.stringify(e.payload)]);}
test('period.cancel persists through the entity store: link, cancelled flag, voided invoice and event survive write+read',async()=>{let s=op(emptyState(),'member.save',{name:'Persist member',phone:'',joined:'2026-09-01',expires:'2026-11-01'});s=op(s,'card.issue',{id:s.members[0].id});s=op(s,'plan.save',{name:'P',days:30,visits:null,minor:10000});const id=s.members[0].id,plan=s.plans[0].id;s=op(s,'plan.assign',{id,plan,start:'2026-10-17',due:'2026-10-17',paid:0,method:'cash',startMode:'replaceCurrent',confirmReplace:true});await seed('P',s);
 let cur=await readEntitySpace('P');s=op(cur.state,'plan.assign',{id,plan,start:'2026-10-20',due:'2026-10-20',paid:0,method:'cash'});await persistSpace('P',{state:cur.state,revision:cur.revision},s);
 cur=await readEntitySpace('P');const added=cur.state.members[0].membershipPeriods.at(-1);assert.ok(added.invoice,'link persisted');assert.equal(cur.state.members[0].expires,'2026-12-15');
 const next=op(cur.state,'period.cancel',{id,period:added.id,reason:'persist check'});await persistSpace('P',{state:cur.state,revision:cur.revision},next);
 const back=await readEntitySpace('P');const m=back.state.members[0],p=m.membershipPeriods.at(-1);assert.equal(p.cancelled,true);assert.equal(p.invoice,added.invoice);assert.equal(m.expires,'2026-11-15');assert.equal(back.state.invoices.find(i=>i.id===added.invoice).voided,true);assert.equal(back.state.invoices.length,2);const ev=back.state.events.find(e=>e.kind==='period.cancel');assert.ok(ev,'event persisted');assert.equal(ev.detail,'persist check');assert.equal(ev.actor,'QA');assert.equal(ev.subject,id);assert.doesNotThrow(()=>validateBackup(back.state));});
after(()=>setTimeout(()=>process.exit(0),200));
