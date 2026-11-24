import {serverAuth} from '../../lib/auth';
import {authBackend} from '../../lib/auth-backend';
import {sameOrigin} from '../../lib/server-workspace';
import {consumeAuthRateLimit} from '../../lib/auth-rate-limit';
export const dynamic='force-dynamic';
const reply=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
const limited=(retryAfter:number)=>{const r=reply({error:'rate'},429);r.headers.set('Retry-After',String(retryAfter));return r;};
// Firebase one-time-code (oobCode) actions for the branded /auth/action page.
// Codes are single-use secrets; only a short prefix feeds the rate-limit key.
const oobValid=(code:unknown):code is string=>typeof code==='string'&&code.length>=16&&code.length<=512&&/^[A-Za-z0-9_-]+$/.test(code);
const identity=(path:string,payload:Record<string,unknown>)=>{
  const apiKey=process.env.FIREBASE_WEB_API_KEY||process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
  if(!apiKey)return null;
  return fetch('https://identitytoolkit.googleapis.com/v1/'+path+'?key='+encodeURIComponent(apiKey),{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),cache:'no-store',
  });
};
const oobFailure=async(response:Response)=>{
  if(response.status===429)return limited(60);
  if(response.status>=500)return reply({error:'unavailable'},503);
  // Invalid or expired codes, disabled accounts and rejected passwords all
  // surface as a fresh-link prompt; the page never echoes Firebase detail.
  return reply({error:'invalid_code'},400);
};
export async function POST(request:Request){
  if(!sameOrigin(request))return reply({error:'origin'},403);
  if(request.headers.get('content-type')?.split(';')[0]!=='application/json')return reply({error:'invalid'},415);
  try{
   const raw=await request.text();if(new TextEncoder().encode(raw).length>2048)return reply({error:'limit'},413);
   let parsed:unknown;try{parsed=JSON.parse(raw);}catch{return reply({error:'invalid'},400);}
   if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return reply({error:'invalid'},400);
   const body=parsed as Record<string,unknown>;
   if(body.action==='reset-info'||body.action==='reset-confirm'||body.action==='verify-email'){
    // One-time-code actions are Firebase-only. Supabase recovery/confirmation
    // runs through /auth/callback (token_hash) plus a session-backed update.
    if(authBackend()==='supabase')return reply({error:'invalid'},400);
    if(!oobValid(body.oobCode))return reply({error:'invalid'},400);
    const limit=await consumeAuthRateLimit('password:'+body.action,request,body.oobCode.slice(0,12),10);
    if(limit.outage){const r=reply({error:'connection'},503);r.headers.set('Retry-After',String(limit.retryAfter));return r;}
    if(!limit.allowed)return limited(limit.retryAfter);
    if(body.action==='reset-info'){
     const response=await identity('accounts:resetPassword',{oobCode:body.oobCode});
     if(!response)return reply({error:'unavailable'},503);
     if(!response.ok)return oobFailure(response);
     const data=await response.json() as {email?:string};
     return reply({ok:true,email:typeof data.email==='string'?data.email:''});
    }
    if(body.action==='reset-confirm'){
     if(typeof body.password!=='string'||body.password.length<12||body.password.length>128)return reply({error:'invalid'},400);
     const response=await identity('accounts:resetPassword',{oobCode:body.oobCode,newPassword:body.password});
     if(!response)return reply({error:'unavailable'},503);
     if(!response.ok)return oobFailure(response);
     return reply({ok:true});
    }
    const response=await identity('accounts:update',{oobCode:body.oobCode});
    if(!response)return reply({error:'unavailable'},503);
    if(!response.ok)return oobFailure(response);
    return reply({ok:true});
   }
   const auth=await serverAuth();
   if(body.action==='request'){
    if(typeof body.email!=='string'||body.email.length>254||!/^\S+@\S+\.\S+$/.test(body.email.trim()))return reply({error:'invalid'},400);
    const limit=await consumeAuthRateLimit('password:request',request,body.email,5);
    if(limit.outage){const r=reply({error:'connection'},503);r.headers.set('Retry-After',String(limit.retryAfter));return r;}
    if(!limit.allowed)return limited(limit.retryAfter);
    // Firebase emails the one-time code; the branded /auth/action handler
    // verifies it and updates the password (custom action URL).
    const {error}=await auth.auth.resetPasswordForEmail(body.email.trim(),new URL('/auth/callback/recovery',request.url).href);
    if(error?.status===429){const r=reply({error:'rate'},429);r.headers.set('Retry-After','60');return r;}
    if(error&&error.status&&error.status>=500)return reply({error:'unavailable'},503);
    return reply({ok:true});
   }
   if(body.action==='update'){
    if(typeof body.password!=='string'||body.password.length<12||body.password.length>128)return reply({error:'invalid'},400);
    const user=await auth.auth.getUser();if(user.error||!user.data.user)return reply({error:'auth'},401);
    const limit=await consumeAuthRateLimit('password:update',request,user.data.user.email??user.data.user.id,5);
    if(limit.outage){const r=reply({error:'connection'},503);r.headers.set('Retry-After',String(limit.retryAfter));return r;}
    if(!limit.allowed)return limited(limit.retryAfter);
    const result=await auth.auth.updateUser({password:body.password});
    if(result.error)return reply({error:'invalid'},400);
    return reply({ok:true});
   }
   return reply({error:'invalid'},400);
  }catch{return reply({error:'unavailable'},503);}
}
