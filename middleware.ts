import { NextResponse, type NextRequest } from 'next/server';
import { planSupabaseSessionRefresh } from './app/lib/supabase-session-refresh';

// Writable refresh boundary for the Supabase auth backend. Server Components
// get a read-only cookie store, so refresh rotation must happen here (or in a
// route handler) before a page render touches the session. The Firebase
// backend needs nothing: its session cookie is verified, never rotated.
export async function middleware(request: NextRequest) {
  if (process.env.GYMOS_AUTH_BACKEND !== 'supabase') return NextResponse.next();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return NextResponse.next();
  const plan = await planSupabaseSessionRefresh({
    url,
    key,
    cookie: request.cookies.get('gymos_session')?.value,
  });
  // Write the rotated pair to the request as well so the downstream render
  // (RSC cookies()) reads the fresh token, and to the response so the browser
  // stores it.
  if (plan.action === 'set') request.cookies.set('gymos_session', plan.value);
  const response = NextResponse.next({ request });
  if (plan.action === 'set') {
    response.cookies.set('gymos_session', plan.value, plan.options);
    // A session-changing response must never be stored or replayed by any
    // cache between us and the browser.
    response.headers.set('Cache-Control', 'private, no-store, must-revalidate');
    response.headers.set('Pragma', 'no-cache');
    response.headers.set('Expires', '0');
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icons|manifest.json).*)'],
};
