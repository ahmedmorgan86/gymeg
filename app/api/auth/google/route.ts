import { cookies } from 'next/headers';
import { randomBytes } from 'node:crypto';

export const dynamic = 'force-dynamic';

// Starts the Google OAuth flow. The state cookie binds the callback to this
// browser and carries the post-sign-in destination ('c' clubs, 'p' platform).
const fail = (origin: string, code: string) =>
  Response.redirect(new URL('/sign-in?error=' + code, origin), 303);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const clientId = process.env.GYMEG_GOOGLE_CLIENT_ID;
  if (!clientId || !process.env.GYMEG_GOOGLE_CLIENT_SECRET) return fail(url.origin, 'google_unavailable');
  const target = url.searchParams.get('returnTo') === '/platform' ? '/platform' : '/clubs';
  const state = randomBytes(24).toString('base64url');
  const store = await cookies();
  store.set('gymos_google_state', state + '.' + (target === '/platform' ? 'p' : 'c'), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  });
  const authorize = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorize.searchParams.set('client_id', clientId);
  authorize.searchParams.set('redirect_uri', new URL('/api/auth/google/callback', url.origin).href);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('scope', 'openid email profile');
  authorize.searchParams.set('state', state);
  return Response.redirect(authorize.href, 303);
}
