import { serverAuth } from '../../lib/auth';

export const dynamic = 'force-dynamic';

// Email-confirmation style callback: the only accepted code is a genuine
// Firebase ID token (verified with revocation checks inside
// exchangeCodeForSession). Garbage codes redirect back to sign-in with a
// generic error and never set a cookie.
export async function GET(request: Request) {
  const url = new URL(request.url);
  // Supabase email links carry token_hash + type (signup confirmation,
  // recovery). Verified at the auth server; failures redirect like bad codes.
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type');
  if (tokenHash && type) {
    try {
      const auth = await serverAuth();
      const { data, error } = await auth.auth.verifyEmailToken(tokenHash, type);
      if (!error && data.session) {
        return Response.redirect(new URL('/clubs', url.origin), 303);
      }
    } catch {
      // Fall through to the failure redirect.
    }
  }
  const code = url.searchParams.get('code') ?? '';
  if (code) {
    try {
      const auth = await serverAuth();
      const { data, error } = await auth.auth.exchangeCodeForSession(code);
      if (!error && data.session) {
        return Response.redirect(new URL('/clubs', url.origin), 303);
      }
    } catch {
      // Fall through to the failure redirect.
    }
  }
  return Response.redirect(new URL('/sign-in?error=confirmation', url.origin), 303);
}
