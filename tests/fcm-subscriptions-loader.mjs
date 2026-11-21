import {registerHooks} from 'node:module';
import './commercial-loader.mjs';

registerHooks({load(url,context,next){
 if(url.endsWith('/node_modules/server-only/index.js')||url.endsWith('/node_modules/server-only/index.mjs'))return{format:'module',shortCircuit:true,source:''};
 if(url.endsWith('/app/lib/member-code-session.ts'))return{format:'module',shortCircuit:true,source:'export const codeMemberIdentity=async()=>globalThis.__fcmIdentity??null;'};
 if(url.endsWith('/app/lib/server-workspace.ts'))return{format:'module',shortCircuit:true,source:'export const context=async(allowClosedTrial=false)=>{if(globalThis.__fcmTrialLocked&&!allowClosedTrial)throw new globalThis.__CommercialError("trialExpired",403);return globalThis.__fcmContext??null;};export const readSpace=async()=>structuredClone(globalThis.__fcmSpace);export const readSpaceSlice=(...a)=>readSpace(...a),readSpaceMeta=(...a)=>readSpace(...a),readMemberSpace=(...a)=>readSpace(...a),readSpaceForPacket=async(...a)=>({current:await readSpace(...a),photoVersions:undefined}),readRevision=async(...a)=>(await readSpace(...a)).revision;export const reply=(data,status=200)=>Response.json(data,{status});export const sameOrigin=r=>r.headers.get("origin")===new URL(r.url).origin;'};
 if(url.endsWith('/app/lib/database.ts'))return{format:'module',shortCircuit:true,source:'export async function withScope(owner,fn){globalThis.__fcmQueries??=[];globalThis.__fcmOwners??=[];globalThis.__fcmOwners.push(owner);return fn({query:async(text,params=[])=>{globalThis.__fcmQueries.push({owner,text,params});return{rows:text.includes("tenant_licenses")&&globalThis.__fcmLicenseRow?[globalThis.__fcmLicenseRow]:[]};}})}'};
 if(url.endsWith('/app/lib/licensing.ts'))return{format:'module',shortCircuit:true,source:'export class CommercialError extends Error{constructor(code,status=403){super(code);this.code=code;this.status=status}}export const licenseState=()=>globalThis.__fcmLicenseState??{writable:true};export const assertGrowth=()=>{};globalThis.__CommercialError=CommercialError;'};
 if(url.endsWith('/app/lib/commercial.ts'))return{format:'module',shortCircuit:true,source:'export const normalizeLicense=x=>x;'};
 if(url.endsWith('/app/lib/firebase-messaging.ts'))return{format:'module',shortCircuit:true,source:'export const firebaseMessagingConfigured=()=>false;'};
 return next(url,context);
}});
