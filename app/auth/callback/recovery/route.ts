import { serverAuth } from '../../../lib/auth';

export const dynamic = 'force-dynamic';

// Recovery-specific email callback. Supabase recovery links (PKCE code or a
// token_hash pair) verify here and land on the new-password form; the
// verified recovery session authorizes the password update. Kept on its own
// path because the auth server's PKCE redirect carries only ?code= — the
// recovery intent has to come from the redirect URL itself.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const fail = () => Response.redirect(new URL('/sign-in?error=confirmation', url.origin), 303);
  try {
    const auth = await serverAuth();
    const tokenHash = url.searchParams.get('token_hash');
    const type = url.searchParams.get('type');
    if (tokenHash && type === 'recovery') {
      const { data, error } = await auth.auth.verifyEmailToken(tokenHash, type);
      if (!error && data.session) {
        return Response.redirect(new URL('/auth/action?mode=resetPassword', url.origin), 303);
      }
      return fail();
    }
    const code = url.searchParams.get('code') ?? '';
    if (code) {
      // GoTrue confirmed the address before issuing this code (verify.go
      // recoverVerify), so the normal confirmed-session gate applies.
      const { data, error } = await auth.auth.exchangeCodeForSession(code);
      if (!error && data.session) {
        return Response.redirect(new URL('/auth/action?mode=resetPassword', url.origin), 303);
      }
      if (error && 'code' in error && error.code === 'pkce_verifier_missing') {
        return Response.redirect(new URL('/sign-in?error=confirmation_same_browser', url.origin), 303);
      }
    }
  } catch {
    // Fall through to the failure redirect.
  }
  return fail();
}
