import {serverAuth} from '../../lib/auth';
import {sameOrigin} from '../../lib/server-workspace';
import {consumeAuthRateLimit} from '../../lib/auth-rate-limit';
export const dynamic='force-dynamic';
const reply=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
const limited=(retryAfter:number)=>{const r=reply({error:'rate'},429);r.headers.set('Retry-After',String(retryAfter));return r;};
export async function POST(request:Request){
  if(!sameOrigin(request))return reply({error:'origin'},403);
  if(request.headers.get('content-type')?.split(';')[0]!=='application/json')return reply({error:'invalid'},415);
  try{
   const raw=await request.text();if(new TextEncoder().encode(raw).length>2048)return reply({error:'limit'},413);
   let parsed:unknown;try{parsed=JSON.parse(raw);}catch{return reply({error:'invalid'},400);}
   if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return reply({error:'invalid'},400);
   const body=parsed as Record<string,unknown>;
   const auth=await serverAuth();
   if(body.action==='request'){
    if(typeof body.email!=='string'||body.email.length>254||!/^\S+@\S+\.\S+$/.test(body.email.trim()))return reply({error:'invalid'},400);
    const limit=consumeAuthRateLimit('password:request',request,body.email,5);
    if(!limit.allowed)return limited(limit.retryAfter);
    // Firebase's hosted password action verifies the one-time code and updates
    // the password. The retired OAuth callback cannot consume Firebase codes.
    const {error}=await auth.auth.resetPasswordForEmail(body.email.trim());
    if(error?.status===429){const r=reply({error:'rate'},429);r.headers.set('Retry-After','60');return r;}
    if(error&&error.status&&error.status>=500)return reply({error:'unavailable'},503);
    return reply({ok:true});
   }
   if(body.action==='update'){
    if(typeof body.password!=='string'||body.password.length<12||body.password.length>128)return reply({error:'invalid'},400);
    const user=await auth.auth.getUser();if(user.error||!user.data.user)return reply({error:'auth'},401);
    const limit=consumeAuthRateLimit('password:update',request,user.data.user.email??user.data.user.id,5);
    if(!limit.allowed)return limited(limit.retryAfter);
    const result=await auth.auth.updateUser({password:body.password});
    if(result.error)return reply({error:'invalid'},400);
    return reply({ok:true});
   }
   return reply({error:'invalid'},400);
  }catch{return reply({error:'unavailable'},503);}
}
