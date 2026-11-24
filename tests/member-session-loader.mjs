import {registerHooks} from 'node:module';
import './commercial-loader.mjs';
registerHooks({load(url,context,next){
  if(url.endsWith('/app/chatgpt-auth.ts'))return{format:'module',shortCircuit:true,source:'export const getChatGPTUser=async()=>null;'};
  if(url.endsWith('/app/lib/database.ts'))return{format:'module',shortCircuit:true,source:`export const getPool=()=>({connect:async()=>globalThis.__qaPhoneClient});
export const withScope=async(owner,fn)=>{const c=globalThis.__qaPhoneClient;await c.query("BEGIN");await c.query("SELECT set_config($1,$2,true)",["app.gym_owner",owner]);try{const value=await fn(c);await c.query("COMMIT");return value;}catch(e){await c.query("ROLLBACK");throw e;}};`};
  if(url.endsWith('/app/lib/server-workspace.ts'))return{format:'module',shortCircuit:true,source:`export const context=async()=>null;
export const readSpace=async owner=>globalThis.__qaPhoneSpaces[owner];export const readSpaceCore=(...a)=>readSpace(...a);export const readSpaceSlice=async(owner,q)=>{globalThis.__qaPhoneSlices??=[];globalThis.__qaPhoneSlices.push({owner,q});const current=await readSpace(owner);return{...current,state:{...current.state,members:current.state.members.filter(m=>q.ids.includes(m.id)&&q.branches.includes(m.branch))}};},readSpaceMeta=(...a)=>readSpace(...a),readMemberSpace=(...a)=>readSpace(...a),readSpaceForPacket=async(...a)=>({current:await readSpace(...a),photoVersions:undefined}),readRevision=async(...a)=>(await readSpace(...a)).revision;
export const reply=(data,status=200)=>Response.json(data,{status});
export const sameOrigin=request=>request.headers.get("origin")===new URL(request.url).origin;
export const requestClientIp=request=>process.env.GYMEG_TRUST_PROXY_IP==="1"?(request.headers.get("x-vercel-forwarded-for")??request.headers.get("x-forwarded-for")??"unknown").split(',')[0].trim():"unknown";`};
  return next(url,context);
}});
