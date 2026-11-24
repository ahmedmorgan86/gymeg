import {registerHooks} from 'node:module';
import {existsSync} from 'node:fs';
registerHooks({resolve(spec,ctx,next){
 if(spec==='server-only')return{url:'data:text/javascript,export{}',shortCircuit:true};
 if(spec==='next/headers')return{url:'data:text/javascript,export const cookies=async()=>({get:name=>name==="gymos-space"?{value:"tenant:x"}:undefined});',shortCircuit:true};
 if(spec.endsWith('/chatgpt-auth')||spec.endsWith('/chatgpt-auth.ts'))return{url:'data:text/javascript,export const getChatGPTUser=async()=>({userId:"user-1",displayName:"U",email:"u@x"});',shortCircuit:true};
 if(spec.endsWith('/commercial')||spec.endsWith('/lib/commercial.ts'))return{url:'data:text/javascript,export const commercialEnabled=()=>true;export const commercialContext=async()=>globalThis.__ctxClub;',shortCircuit:true};
 if(spec.startsWith('.')&&!/\.[a-z]+$/i.test(spec)&&ctx.parentURL&&ctx.parentURL.startsWith('file:')&&existsSync(new URL(spec+'.ts',ctx.parentURL)))return next(spec+'.ts',ctx);
 return next(spec,ctx);
}});
