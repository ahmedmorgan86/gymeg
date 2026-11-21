// Barcode route over a REAL entity-layout club: state reads go through the real slice backend on PGlite
// (real migrations), not an in-memory alias. readSpaceMeta is the true metadata-only read.
import './role-api-loader.mjs';
import {registerHooks} from 'node:module';
const sliceUrl=new URL('../app/lib/workspace-slice.ts',import.meta.url).href,extUrl=new URL('../app/lib/extensions.ts',import.meta.url).href;
registerHooks({load(url,ctx,next){
  if(url.endsWith('/app/lib/database.ts'))return{format:'module',shortCircuit:true,source:`export const getPool=()=>({connect:async()=>({query:(sql,v)=>globalThis.__entityDb.query(sql,v),release(){}})});export async function withScope(owner,work){return globalThis.__entityDb.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);return work(c);});}`};
  if(url.endsWith('/app/lib/server-workspace.ts')){const real=next(url,ctx);let src=String(real.source);
    src=src.replace('export const readSpace=async()=>structuredClone(globalThis.__qaSpace);','').replace('readSpaceMeta=(...a)=>readSpace(...a),','');
    return{...real,source:src+`
import {postgresBackend,readSlice} from ${JSON.stringify(sliceUrl)};import {normalize as __n} from ${JSON.stringify(extUrl)};
const __be=()=>postgresBackend(async(owner,work)=>globalThis.__entityDb.transaction(async c=>{await c.query("SELECT set_config('app.gym_owner',$1,true)",[owner]);return work(c);}));
const __all=['members','visits','payments','invoices','plans','classes','shifts','programs','trainingAssignments','trainingSessions','coaching','coaches'];
export const readSpace=async owner=>{const r=await readSlice(__be(),owner,{collections:__all},__n);return{state:r.state,revision:r.revision};};
export const readSpaceMeta=async owner=>{const r=await readSlice(__be(),owner,null,__n);return{state:r.state,revision:r.revision};};
`};}
  return next(url,ctx);
}});
