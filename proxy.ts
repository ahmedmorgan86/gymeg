import {previewFence,PREVIEW_TENANT} from './app/lib/rehearsal-preview-fence';
import {supportWriteBlocked} from './app/lib/support-policy';
import {planSupabaseSessionRefresh} from './app/lib/supabase-session-refresh';
import {NextResponse,type NextRequest} from 'next/server';

// Next 16 allows a single proxy entry point (Node runtime): proxy.ts. It merges the legacy
// header policy (support write-block plus robots/cache headers on the app
// surfaces) with the Supabase session-refresh boundary, which must run on
// every matched route because any page render can touch the session.
const headerPaths=new Set(['/member','/','/clubs','/platform','/support-install','/support-login','/sign-in','/sign-out']);
const headerPrefixes=['/auth/','/api/'];
function headerPath(pathname:string){
  return headerPaths.has(pathname)||headerPrefixes.some((p)=>pathname.startsWith(p));
}

export async function proxy(request:NextRequest){
  const fenced=previewFence(request.method,request.nextUrl.pathname);
  if(fenced==='deny')return NextResponse.json({error:'previewReadOnly'},{status:403,headers:{'Cache-Control':'no-store'}});
  if(fenced==='allow')request.cookies.set('gymos-space',PREVIEW_TENANT);
  if(supportWriteBlocked(request.method,request.nextUrl.pathname,request.cookies.has('gymos-support')))
    return NextResponse.json({error:'supportReadOnly'},{status:403,headers:{'Cache-Control':'no-store'}});

  // Writable refresh boundary for the Supabase auth backend. Server
  // Components get a read-only cookie store, so refresh rotation must
  // happen here before a page render touches the session. The Firebase
  // backend needs nothing: its session cookie is verified, never rotated.
  let plan:Awaited<ReturnType<typeof planSupabaseSessionRefresh>>|null=null;
  if(process.env.GYMOS_AUTH_BACKEND==='supabase'){
    const url=process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    if(url&&key)plan=await planSupabaseSessionRefresh({url,key,cookie:request.cookies.get('gymos_session')?.value});
  }
  // Write the rotated pair to the request as well so the downstream render
  // (RSC cookies()) reads the fresh token, and to the response so the
  // browser stores it.
  if(plan&&plan.action==='set')request.cookies.set('gymos_session',plan.value);
  const response=NextResponse.next({request});
  if(fenced==='allow')response.cookies.set('gymos-space',PREVIEW_TENANT,{httpOnly:true,secure:true,sameSite:'lax',path:'/'});
  // Robots policy is independent of refresh: a refreshed request to an app
  // surface still must not be indexed.
  const pathname=request.nextUrl.pathname;
  if(fenced==='allow'||headerPath(pathname)&&pathname!=='/')response.headers.set('X-Robots-Tag','noindex, nofollow, noarchive');
  if(plan&&plan.action==='set'){
    response.cookies.set('gymos_session',plan.value,plan.options);
    // A session-changing response must never be stored or replayed by any
    // cache between us and the browser; this stronger policy replaces the
    // default one below.
    response.headers.set('Cache-Control','private, no-store, must-revalidate');
    response.headers.set('Pragma','no-cache');
    response.headers.set('Expires','0');
  }else if(headerPath(pathname)){
    response.headers.set('Cache-Control','private, no-store');
  }
  return response;
}

// The broad matcher is the refresh boundary's: rotation must be possible on
// any route that can read the session; the header policy self-scopes above.
export const config={matcher:['/:path*']};
