import {serverAuth} from '../../lib/auth';
import {loginCode,loginCredentials} from '../../lib/login-errors';
import {sameOrigin} from '../../lib/server-workspace';
import {consumeAuthRateLimit} from '../../lib/auth-rate-limit';
export const dynamic='force-dynamic';
const reply=(body:unknown,status:number)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
const limited=(retryAfter:number)=>{const r=reply({error:'rate_limit'},429);r.headers.set('Retry-After',String(retryAfter));return r;};
export async function DELETE(request:Request){
 if(!sameOrigin(request))return reply({error:'origin'},403);
 try{
  const auth=await serverAuth();
  // Supabase supports 'global' | 'local' | 'others'. 'local' leaves refresh
  // tokens on other devices alive, so a shared-device sign-out must be global.
  const {error}=await auth.auth.signOut({scope:'global'});
  if(error)return reply({error:'signout_failed'},(error.status??0)>=500?503:400);
  return reply({ok:true},200);
 }catch{return reply({error:'connection'},503);}
}

export async function POST(request:Request){
 if(!sameOrigin(request))return reply({error:'origin'},403);
 if(request.headers.get('content-type')?.split(';')[0]!=='application/json')return reply({error:'invalid'},415);
 try{
  const raw=await request.text();if(new TextEncoder().encode(raw).length>4096)return reply({error:'invalid'},413);
  let parsed:unknown;try{parsed=JSON.parse(raw);}catch{return reply({error:'invalid'},400);}
  const credentials=loginCredentials(parsed);if(!credentials)return reply({error:'invalid_credentials'},400);
  const limit=await consumeAuthRateLimit('session:login',request,credentials.email,10);
  if(limit.outage){const r=reply({error:'connection'},503);r.headers.set('Retry-After',String(limit.retryAfter));return r;}
  if(!limit.allowed)return limited(limit.retryAfter);
  const auth=await serverAuth();const result=await auth.auth.signInWithPassword(credentials);
  // Preserve server-side auth failures as 503 instead of masking them as 400,
  // so a real service outage is not reported to the user as bad credentials.
  if(result.error){const status=result.error.status===429?429:(result.error.status??0)>=500?503:400;const r=reply({error:loginCode(result.error)},status);if(result.error.status===429)r.headers.set('Retry-After','60');return r;}
  if(!result.data.session)return reply({error:'auth_failed'},401);
  return reply({ok:true},200);
 }catch{return reply({error:'connection'},503);}
}
