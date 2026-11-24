import { cookies } from 'next/headers';
import { createHash, randomBytes } from 'node:crypto';
import { isHandoffClient, CHALLENGE_PATTERN } from '../../../lib/mobile-handoff.ts';

export const dynamic = 'force-dynamic';

// Starts the Google OAuth flow. The state cookie binds the callback to this
// browser and carries the post-sign-in destination ('c' clubs, 'p' platform);
// a hashed nonce binds Google's ID token to this authorize request.
//
// Android shells start the flow in the system browser with client=android-*
// and hc=<SHA-256 challenge of an app-held verifier>. Both ride in the state
// cookie so the callback can route the session to a single-use handoff and
// bind the later exchange to the app instance that started here. An android
// client without a well-formed challenge is rejected up front.
const fail = (origin: string, code: string) =>
  Response.redirect(new URL('/sign-in?error=' + code, origin), 303);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const clientId = process.env.GYMEG_GOOGLE_CLIENT_ID;
  if (!clientId || !process.env.GYMEG_GOOGLE_CLIENT_SECRET) return fail(url.origin, 'google_unavailable');
  const target = url.searchParams.get('returnTo') === '/platform' ? '/platform' : '/clubs';
  const clientParam = url.searchParams.get('client');
  const challengeParam = url.searchParams.get('hc');
  if (clientParam !== null && (!isHandoffClient(clientParam) || !challengeParam || !CHALLENGE_PATTERN.test(challengeParam))) {
    return fail(url.origin, 'google_failed');
  }
  const state = randomBytes(24).toString('base64url');
  const store = await cookies();
  const stateValue = state + '.' + (target === '/platform' ? 'p' : 'c') + (clientParam ? '.' + clientParam + '.' + challengeParam : '');
  store.set('gymos_google_state', stateValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  });
  const nonce = randomBytes(24).toString('base64url');
  store.set('gymos_google_nonce', nonce, {
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
  // GoTrue compares the ID token's nonce claim against the SHA-256 of the
  // raw nonce rendered as LOWERCASE HEX (token_oidc.go), so the hashed value
  // Google embeds must use that exact encoding.
  authorize.searchParams.set('nonce', createHash('sha256').update(nonce).digest('hex'));
  return Response.redirect(authorize.href, 303);
}
