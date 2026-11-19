import {supportWriteBlocked} from './app/lib/support-policy';
import {NextResponse,type NextRequest} from 'next/server';

export async function proxy(request:NextRequest){
  if(supportWriteBlocked(request.method,request.nextUrl.pathname,request.cookies.has('gymos-support')))
    return NextResponse.json({error:'supportReadOnly'},{status:403,headers:{'Cache-Control':'no-store'}});

  let response=NextResponse.next({request});
  if(request.nextUrl.pathname!=='/')response.headers.set('X-Robots-Tag','noindex, nofollow, noarchive');
  response.headers.set('Cache-Control','private, no-store');
  return response;
}

export const config={matcher:['/member','/','/clubs','/platform','/support-install','/support-login','/sign-in','/sign-out','/auth/:path*','/api/:path*']};
