import {test} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
registerHooks({
 resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}},
 load(url,c,n){
  if(url.endsWith('/app/lib/database.ts'))return{format:'module',shortCircuit:true,source:`export const getPool=()=>{throw Error('NO LIVE DB');};export const withScope=(o,work)=>work({query:(s,p)=>globalThis.__wa.query(s,p)});`};
  if(url.endsWith('/app/lib/server-workspace.ts'))return{format:'module',shortCircuit:true,source:`export const readSpace=async()=>{globalThis.__wa.full++;return{state:structuredClone(globalThis.__wa.state)};};`};
  if(url.endsWith('/app/lib/firestore-db.ts'))return{format:'module',shortCircuit:true,source:`export const useFirestorePersistence=()=>false;`};
  if(url.endsWith('/app/lib/whatsapp-job-page.ts'))return{format:'module',shortCircuit:true,source:`export const readWhatsAppJobPage=async(s,q)=>{globalThis.__wa.pages.push(q);return globalThis.__wa.page(q);};`};
  if(url.endsWith('/app/lib/commercial.ts'))return{format:'module',shortCircuit:true,source:`export const normalizeLicense=x=>x;`};
  return n(url,c);
 }
});
const {runWhatsApp}=await import('../app/lib/whatsapp-server.ts');
const {emptyState,dayAt}=await import('../app/lib/domain.ts');
const now=new Date().toISOString(),day=dayAt(now,'Africa/Cairo');
const rule={id:'6bbba33d-e170-4cd3-a14e-cc503d477457',branch:'main',name:'Test',kind:'occasion',enabled:true,time:'00:00',template:'test',language:'ar',offset:1,date:day,parameters:[],createdAt:now};
function setup(mode){
 const state=emptyState();state.settings.timezone='Africa/Cairo';state.members=[{id:'synthetic',name:'Synthetic',branch:'main',phone:'+201000000001',joined:day,expires:day,whatsapp:{enabled:true}}];
 const w=globalThis.__wa={state,full:0,pages:[],ids:new Set(),claimed:false,status:null};
 const due={member:'synthetic',occurrence:day,to:'201000000001',parameters:[]};
 w.page=q=>q.memberId&&mode==='unavailable'?{status:'fallback',reason:'visit-day'}:({status:'ok',version:'1',next:null,jobs:q.memberId?(mode==='phone'?[{...due,to:'201000000002'}]:mode==='consent'?[]:[due]):[due]});
 w.query=async(sql,p)=>{
  if(sql.includes('statement_timeout'))return{rows:[]};
  if(sql.includes("to_regclass('gymos.whatsapp_scan_cursor')")||sql.includes('pg_try_advisory_xact_lock'))return{rows:[{ok:true}]};
  if(sql.startsWith('SELECT cursor'))return{rows:[]};
  if(sql.startsWith('INSERT INTO gymos.whatsapp_scan_cursor'))return{rows:[]};
  if(sql.includes('tenant_licenses'))return{rows:[]};
  if(sql.startsWith('SELECT payload FROM gymos.whatsapp_rules')||sql.startsWith('SELECT r.payload FROM gymos.whatsapp_rules'))return{rows:[{payload:sql.includes('id=$2')&&mode==='rule-disabled'?{...rule,enabled:false}:sql.includes('id=$2')&&mode==='rule-branch'?{...rule,branch:'foreign'}:rule}]};
  if(sql.startsWith('INSERT INTO gymos.whatsapp_outbox')){if(sql.includes('jsonb_to_recordset'))for(const j of JSON.parse(p[3]))w.ids.add(j.id);else w.ids.add(p[1]);if(mode==='legacy-consent')w.state.members[0].whatsapp.enabled=false;return{rows:[]};}
  if(sql.includes('FOR UPDATE SKIP LOCKED')){if(w.claimed)return{rows:[]};w.claimed=true;return{rows:[{id:'pending-synthetic',branch:'main',member_id:'synthetic',rule_id:rule.id,occurrence:day,payload:{to:due.to}}]};}
  if(sql.includes('FROM gymos.whatsapp_connections'))return{rows:[{api_version:'v99.0',phone_id:'never-contact',token_cipher:'not-a-secret'}]};
  if(sql.includes('whatsapp_opted_out'))return{rows:[{out:mode==='optout'}]};
  if(sql.startsWith('UPDATE gymos.whatsapp_outbox')){if(sql.includes('status=$3'))w.status=p[2];return{rows:[]};}
  throw Error('UNEXPECTED QUERY '+sql);
 };
 return w;
}
test('default-OFF sender retains full read and fresh consent cancellation; enabled selector rechecks without full-state reads',async()=>{
 const prior=process.env.GYMOS_WHATSAPP_READS,fetch=globalThis.fetch;
 globalThis.fetch=async()=>{assert.fail('No external sending is allowed in this test');};
 try{
  delete process.env.GYMOS_WHATSAPP_READS;const legacy=setup('legacy-consent');assert.deepEqual(await runWhatsApp('synthetic-owner','main'),{sent:0});assert.equal(legacy.status,'cancelled');assert.equal(legacy.full,2);assert.equal(legacy.pages.length,0);
  process.env.GYMOS_WHATSAPP_READS='1';
  for(const mode of ['consent','phone','optout','rule-disabled','rule-branch','unavailable']){const w=setup(mode);assert.deepEqual(await runWhatsApp('synthetic-owner','main'),{sent:0,deferred:mode==='unavailable'},mode);assert.equal(w.status,mode==='unavailable'?'pending':'cancelled',mode);assert.equal(w.full,0,mode);assert.equal(w.ids.size,1,mode);if(mode!=='rule-branch')assert.equal(w.pages[1].memberId,'synthetic');}
 }finally{globalThis.fetch=fetch;if(prior===undefined)delete process.env.GYMOS_WHATSAPP_READS;else process.env.GYMOS_WHATSAPP_READS=prior;}
});
