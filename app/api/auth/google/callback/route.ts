import { cookies } from 'next/headers';
import { serverAuth } from '../../../../lib/auth';
import { authBackend } from '../../../../lib/auth-backend';
import { isHandoffClient, createHandoff } from '../../../../lib/mobile-handoff.ts';

export const dynamic = 'force-dynamic';

// Google OAuth callback: exchanges the authorization code for a Google ID
// token, signs it into Firebase Authentication (accounts:signInWithIdp,
// creating the Firebase user on first sign-in), then sets the same
// gymos_session cookie the email/password flow uses.
const fail = (origin: string, code: string) =>
  Response.redirect(new URL('/sign-in?error=' + code, origin), 303);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const store = await cookies();
  const saved = store.get('gymos_google_state')?.value;
  const savedNonce = store.get('gymos_google_nonce')?.value;
  // The flow cookies are consumed only after the callback proves it belongs
  // to the flow they guard: a stray or bogus callback must not destroy a
  // pending sign-in from this browser.
  if (!code || !state || !saved || !savedNonce) return fail(url.origin, 'google_failed');
  const [savedState, savedTarget, savedClient, savedChallenge] = saved.split('.');
  if (!savedState || savedState !== state) return fail(url.origin, 'google_failed');
  store.delete('gymos_google_state');
  store.delete('gymos_google_nonce');
  const target = savedTarget === 'p' ? '/platform' : '/clubs';
  // Android shells: the state cookie carries the client tag and the app's
  // handoff challenge from the flow start. Both must be present together;
  // a partial or malformed pair is not a handoff flow.
  const handoff = savedClient !== undefined || savedChallenge !== undefined;
  const handoffClient = handoff && isHandoffClient(savedClient) && savedChallenge ? savedClient : null;
  if (handoff && !handoffClient) return fail(url.origin, 'google_failed');

  const clientId = process.env.GYMEG_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GYMEG_GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return fail(url.origin, 'google_unavailable');
  const redirectUri = new URL('/api/auth/google/callback', url.origin).href;

  try {
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    if (!tokenResponse.ok) return fail(url.origin, 'google_failed');
    const tokens = await tokenResponse.json() as { id_token?: string };
    if (!tokens.id_token) return fail(url.origin, 'google_failed');

    // Supabase backend: the Google ID token is exchanged at the auth server
    // directly (id_token grant); no Firebase web API key is involved.
    if (authBackend() === 'supabase') {
      const auth = await serverAuth();
      if (handoffClient) {
        // System-browser flow: no cookie here (this response lands in Chrome,
        // not the WebView). The validated session is stored behind a
        // single-use code and the app claims it through the App Link
        // redirect plus its verifier at the exchange endpoint. Neither the
        // code nor the session ever appears in logs.
        const result = await auth.auth.signInWithIdTokenForHandoff('google', tokens.id_token, savedNonce);
        if (result.error || !result.data.sessionValue) {
          return fail(url.origin, result.error && 'code' in result.error && result.error.code === 'email_not_confirmed' ? 'email_not_confirmed' : 'google_failed');
        }
        const code = await createHandoff(result.data.sessionValue, handoffClient, savedChallenge as string);
        const handoffUrl = new URL('/auth/mobile/callback', url.origin);
        handoffUrl.searchParams.set('client', handoffClient);
        handoffUrl.searchParams.set('code', code);
        return Response.redirect(handoffUrl, 303);
      }
      const result = await auth.auth.signInWithIdToken('google', tokens.id_token, savedNonce);
      if (result.error || !result.data.session) {
        return fail(url.origin, result.error && 'code' in result.error && result.error.code === 'email_not_confirmed' ? 'email_not_confirmed' : 'google_failed');
      }
      return Response.redirect(new URL(target, url.origin), 303);
    }

    const apiKey = process.env.FIREBASE_WEB_API_KEY || process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
    if (!apiKey) return fail(url.origin, 'google_unavailable');
    const firebaseResponse = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=' + encodeURIComponent(apiKey), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        postBody: 'id_token=' + encodeURIComponent(tokens.id_token) + '&providerId=google.com',
        requestUri: redirectUri,
        returnSecureToken: true,
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    if (!firebaseResponse.ok) return fail(url.origin, 'google_failed');
    const firebaseResult = await firebaseResponse.json() as { idToken?: string };
    if (!firebaseResult.idToken) return fail(url.origin, 'google_failed');

    const auth = await serverAuth();
    const result = await auth.auth.signInWithFirebaseToken(firebaseResult.idToken);
    if (result.error || !result.data.session) {
      return fail(url.origin, result.error && 'code' in result.error && result.error.code === 'email_not_confirmed' ? 'email_not_confirmed' : 'google_failed');
    }
    return Response.redirect(new URL(target, url.origin), 303);
  } catch {
    return fail(url.origin, 'google_failed');
  }
}
