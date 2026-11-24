import {existsSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {dirname,resolve as r} from 'node:path';
export async function resolve(specifier,context,next){
 try{return await next(specifier,context);}catch(e){
  if(e && e.code==='ERR_MODULE_NOT_FOUND' && (specifier.startsWith('./')||specifier.startsWith('../')) && context.parentURL){
   const p=r(dirname(fileURLToPath(context.parentURL)),specifier)+'.ts';
   if(existsSync(p))return {url:pathToFileURL(p).href,shortCircuit:true};
  }
  throw e;
 }
}
