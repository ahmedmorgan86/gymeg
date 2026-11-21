import {test} from 'node:test';import assert from 'node:assert/strict';import {registerHooks} from 'node:module';import {bootstrapDb} from './db-bootstrap-helpers.mjs';
const db=globalThis.__restoreEpochDb=await bootstrapDb();delete process.env.GYMOS_COMMERCIAL;
registerHooks({resolve(s,c,n){try{return n(s,c);}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'&&s.startsWith('.')&&!/\.[a-z]+$/i.test(s))return n(s+'.ts',c);throw e;}},load(url,c,n){
 if(url.endsWith('/app/lib/database.ts'))return{format:'module',shortCircuit:true,source:`export const getPool=()=>({connect:async()=>({query:async(s,v)=>{if(s==='COMMIT'&&globalThis.__failRestoreCommit)throw Error('injected commit failure');return globalThis.__restoreEpochDb.query(s,v)},release(){}})});`};
 if(url.endsWith('/app/lib/firestore-db.ts'))return{format:'module',shortCircuit:true,source:'export const getFirestoreDb=()=>{throw Error("unexpected")};export const useFirestorePersistence=()=>false;export const firestorePersistSpace=()=>{throw Error("unexpected")};export const firestoreReadSpace=()=>{throw Error("unexpected")};'};
 if(url.endsWith('/app/lib/realtime-broadcast.ts'))return{format:'module',shortCircuit:true,source:'export const processWorkspaceOutbox=async()=>{};'};return n(url,c);
}});
const {persistSpace,readEntitySpace}=await import('../app/lib/entity-store.ts');const {emptyState}=await import('../app/lib/domain.ts');const {splitState}=await import('../app/lib/entity-state.ts');const {readOwnerVersion}=await import('../app/lib/member-summary-store.ts');
async function seed(owner){const state={...emptyState(),generation:'old-epoch'};const {metadata}=splitState(state);await db.query('INSERT INTO gymos.gym_states(user_id,payload,revision,updated_at) VALUES($1,$2,7,$3)',[owner,JSON.stringify(metadata),'now']);return{state,revision:7};}
const version=o=>readOwnerVersion(db,o);
test('unchanged-payload restore rotates epoch and live cache token atomically without importing revision or mutating caller',async()=>{
 const owner='restore-epoch-A',other='restore-epoch-B',current=await seed(owner);await seed(other);const token=await version(owner),foreign=await version(other);const supplied=structuredClone(current.state);
 assert.equal(await persistSpace(owner,current,supplied,true),true);const actual=await readEntitySpace(owner);assert.match(actual.state.generation,/^[0-9a-f-]{36}$/);assert.notEqual(actual.state.generation,current.state.generation);assert.equal(supplied.generation,'old-epoch');assert.equal(actual.revision,8);assert.notEqual(await version(owner),token);assert.equal(await version(other),foreign);
 const token2=await version(owner),epoch=actual.state.generation;assert.equal(await persistSpace(owner,current,supplied,true),false);assert.equal(await version(owner),token2);assert.equal((await readEntitySpace(owner)).state.generation,epoch);
 assert.equal(await persistSpace(owner,actual,actual.state,true),true);assert.notEqual((await readEntitySpace(owner)).state.generation,epoch);
});
test('failed restore rolls back epoch revision and owner token, ordinary save preserves epoch',async()=>{
 const owner='restore-epoch-failure',current=await seed(owner),token=await version(owner);globalThis.__failRestoreCommit=true;
 try{await assert.rejects(persistSpace(owner,current,current.state,true),/injected commit failure/);}finally{globalThis.__failRestoreCommit=false;}
 assert.equal(await version(owner),token);assert.equal((await readEntitySpace(owner)).revision,7);assert.equal((await readEntitySpace(owner)).state.generation,'old-epoch');
 assert.equal(await persistSpace(owner,current,current.state),true);assert.equal((await readEntitySpace(owner)).state.generation,'old-epoch');
});
