import {registerHooks} from 'node:module';
import './commercial-loader.mjs';

registerHooks({load(url,context,next){
 if(url.endsWith('/app/lib/member-code-session.ts'))return{format:'module',shortCircuit:true,source:'export const codeMemberIdentity=async()=>globalThis.__pushIdentity??null;'};
 if(url.endsWith('/app/lib/server-workspace.ts'))return{format:'module',shortCircuit:true,source:'export const context=async()=>globalThis.__pushContext??null;export const readSpace=async()=>structuredClone(globalThis.__pushSpace);export const readSpaceSlice=(...a)=>readSpace(...a),readSpaceMeta=(...a)=>readSpace(...a),readMemberSpace=(...a)=>readSpace(...a),readSpaceForPacket=async(...a)=>({current:await readSpace(...a),photoVersions:undefined}),readRevision=async(...a)=>(await readSpace(...a)).revision;export const reply=(data,status=200)=>Response.json(data,{status});export const sameOrigin=r=>r.headers.get("origin")===new URL(r.url).origin;'};
 if(url.endsWith('/app/lib/database.ts'))return{format:'module',shortCircuit:true,source:'export async function withScope(owner,fn){globalThis.__pushQueries??=[];globalThis.__pushOwners??=[];globalThis.__pushOwners.push(owner);return fn({query:async(text,params=[])=>{globalThis.__pushQueries.push({owner,text,params});return{rows:[]};}})}'};
 if(url.endsWith('/app/lib/licensing.ts'))return{format:'module',shortCircuit:true,source:'export class CommercialError extends Error{constructor(code,status=403){super(code);this.code=code;this.status=status}}export const licenseState=()=>({writable:true});export const assertGrowth=()=>{};'};
 if(url.endsWith('/app/lib/commercial.ts'))return{format:'module',shortCircuit:true,source:'export const normalizeLicense=x=>x;'};
 if(url.endsWith('/app/lib/web-push.ts'))return{format:'module',shortCircuit:true,source:'export const webPushConfigured=()=>true;export const webPushPublicKey=()=>"A".repeat(87);'};
 return next(url,context);
}});
