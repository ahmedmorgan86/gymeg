// Preview-only request fence. It is not authentication or a replacement for RLS.
// Explicit switch on a non-preview deployment refuses all non-static requests.
export const PREVIEW_TENANT='8fe27fc0-d42f-4bf3-be47-5ca734c2ce74';
export const PREVIEW_OWNER='tenant:'+PREVIEW_TENANT;
export const PREVIEW_ACTOR='b8a3d991-04a7-4b11-a680-6f60cfbc5250';
export function previewFence(method:string,path:string,env:Record<string,string|undefined>=process.env):'off'|'allow'|'deny'{
 if(env.GYMOS_REHEARSAL_PREVIEW!=='1')return'off';
 if(env.VERCEL_ENV!=='preview')return'deny';
 if(method==='POST'&&path==='/api/session')return'allow'; // password login only; existing rate limit writes are expected
 if(method!=='GET'&&method!=='HEAD')return'deny';
 if(path.startsWith('/api/'))return new Set(['/api/workspace','/api/workspace/member-candidates','/api/workspace/member-detail']).has(path)?'allow':'deny';
 if(path==='/'||path==='/sign-in'||path.startsWith('/_next/')||path.startsWith('/icons/')||path.startsWith('/fonts/')||path==='/favicon.ico'||path==='/manifest.json')return'allow';
 return'deny';
}
export const previewActorAllowed=(actor:string,env:Record<string,string|undefined>=process.env)=>env.GYMOS_REHEARSAL_PREVIEW!=='1'||env.VERCEL_ENV==='preview'&&actor===PREVIEW_ACTOR;
export const previewOwnerAllowed=(owner:string,env:Record<string,string|undefined>=process.env)=>env.GYMOS_REHEARSAL_PREVIEW!=='1'||env.VERCEL_ENV==='preview'&&owner===PREVIEW_OWNER;
