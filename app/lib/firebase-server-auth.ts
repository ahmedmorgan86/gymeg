import type { cookies } from 'next/headers';
import { isFirebaseConfigured, getFirestoreDb } from './firestore-db.ts';
import { logAuthDiagnostic, SESSION_MAX_AGE_SECONDS, sessionCookieOptions } from './auth-backend.ts';

type CookieStore = Awaited<ReturnType<typeof cookies>>;

// Identity Toolkit error payloads carry the machine code in error.message,
// sometimes with detail appended after ' : ' (e.g. 'WEAK_PASSWORD : ...').
function firebaseErrorCode(payload: unknown): string | null {
  const message = (payload as { error?: { message?: unknown } } | null)?.error?.message;
  if (typeof message !== 'string') return null;
  const code = message.split(' : ')[0]?.trim();
  return code && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : null;
}

async function responseErrorCode(response: Response): Promise<string | null> {
  try {
    return firebaseErrorCode(await response.json());
  } catch {
    return null;
  }
}

function adminErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[a-z0-9/_-]+$/i.test(code) ? code : null;
}

// The Admin SDK app is registered under a fixed name (see firestore-db.ts);
// the no-argument getAuth() resolves the default app, which never exists here
// and throws app/no-app at runtime. Always bind Auth to the named app.
async function adminAuth() {
  getFirestoreDb();
  const { getAuth } = await import('firebase-admin/auth');
  const { getApps } = await import('firebase-admin/app');
  const app = getApps().find((candidate) => candidate.name === 'gymeg-workspace');
  if (!app) throw new Error('Firebase admin app unavailable');
  return getAuth(app);
}

// Firebase Auth provider (legacy production backend). Selected by
// GYMOS_AUTH_BACKEND=firebase or an unset value; see auth-backend.ts.
export function firebaseServerAuth(store: CookieStore) {
  const sessionToken = store.get('gymos_session')?.value;
  // Mobile clients authenticate with a Firebase ID token in this cookie.
  const mobileToken = store.get('sb-token')?.value;

  return {
    auth: {
      async getUser() {
        const token = sessionToken ?? mobileToken;
        if (!token) return { data: { user: null }, error: null };
        try {
          if (isFirebaseConfigured()) {
            const auth = await adminAuth();
            // Sessions are trusted only after firebase-admin verifies them
            // with revocation checks: a session cookie for web clients, an ID
            // token for mobile clients. No unsigned or decoded-only token is
            // ever accepted.
            let decoded;
            try {
              decoded = await auth.verifySessionCookie(token, true);
            } catch {
              try {
                decoded = await auth.verifyIdToken(token, true);
              } catch { return { data: { user: null }, error: null }; }
            }
            if (!decoded.email_verified) return { data: { user: null }, error: null };
            return {
              data: {
                user: {
                  id: decoded.uid,
                  email: decoded.email,
                  is_anonymous: false,
                  user_metadata: { name: decoded.name || decoded.email || 'Member' },
                },
              },
              error: null,
            };
          }
          return { data: { user: null }, error: null };
        } catch (e) {
          return { data: { user: null }, error: e };
        }
      },

      async signInWithPassword({ email, password }: { email: string; password: string }) {
        if (!email || !password) {
          return { data: { session: null }, error: { message: 'Invalid credentials', status: 400 } };
        }
        const apiKey = process.env.FIREBASE_WEB_API_KEY || process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
        if (!apiKey || !isFirebaseConfigured()) {
          return { data: { session: null }, error: { message: 'Auth unavailable', status: 503 } };
        }
        let result: { idToken?: string };
        try {
          const response = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + encodeURIComponent(apiKey), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, returnSecureToken: true }),
            cache: 'no-store',
          });
          if (!response.ok) {
            const code = await responseErrorCode(response);
            logAuthDiagnostic('sign-in', response.status, code);
            if (response.status >= 500) return { data: { session: null }, error: { message: 'Auth unavailable', status: 503 } };
            if (response.status === 429 || code === 'TOO_MANY_ATTEMPTS_TRY_LATER') return { data: { session: null }, error: { message: 'Too many attempts', status: 429 } };
            return { data: { session: null }, error: { code: 'invalid_credentials', message: 'Invalid credentials', status: 401 } };
          }
          result = await response.json() as { idToken?: string };
        } catch {
          logAuthDiagnostic('sign-in', null, 'FETCH');
          return { data: { session: null }, error: { message: 'Auth unavailable', status: 503 } };
        }
        try {
          if (!result.idToken) throw new Error('Missing Firebase ID token');
          const auth = await adminAuth();
          const verified = await auth.verifyIdToken(result.idToken, true);
          if (!verified.email_verified) return { data: { session: null }, error: { code: 'email_not_confirmed', message: 'Email not verified', status: 403 } };
          const tokenPayload = await auth.createSessionCookie(result.idToken, { expiresIn: SESSION_MAX_AGE_SECONDS * 1000 });
          store.set('gymos_session', tokenPayload, sessionCookieOptions);
          return { data: { session: { access_token: tokenPayload } }, error: null };
        } catch (e) {
          logAuthDiagnostic('sign-in-session', null, adminErrorCode(e));
          return { data: { session: null }, error: { message: 'Auth unavailable', status: 503 } };
        }
      },

      // Establishes the same session as signInWithPassword from a Firebase ID
      // token minted for an external provider (the Google OAuth callback
      // exchanges the Google credential through accounts:signInWithIdp first).
      // Supabase-backend-only entry points; the routes branch on
      // authBackend() before calling them, so these never run on Firebase.
      async signInWithIdToken(_provider: 'google', _idToken: string) {
        return { data: { session: null }, error: { message: 'Invalid credentials', status: 400 } };
      },

      async verifyEmailToken(_tokenHash: string, _type: string) {
        return { data: { session: null }, error: { message: 'Invalid confirmation code', status: 400 } };
      },

      async signInWithFirebaseToken(idToken: string) {
        if (!idToken || !isFirebaseConfigured()) {
          return { data: { session: null }, error: { message: 'Auth unavailable', status: 503 } };
        }
        try {
          const auth = await adminAuth();
          const verified = await auth.verifyIdToken(idToken, true);
          if (!verified.email_verified) return { data: { session: null }, error: { code: 'email_not_confirmed', message: 'Email not verified', status: 403 } };
          const tokenPayload = await auth.createSessionCookie(idToken, { expiresIn: SESSION_MAX_AGE_SECONDS * 1000 });
          store.set('gymos_session', tokenPayload, sessionCookieOptions);
          return { data: { session: { access_token: tokenPayload } }, error: null };
        } catch (e) {
          logAuthDiagnostic('firebase-token-sign-in', null, adminErrorCode(e));
          return { data: { session: null }, error: { message: 'Auth unavailable', status: 503 } };
        }
      },

      async signUp({ email, password, name }: { email: string; password: string; name: string; redirectTo?: string }) {
        const apiKey = process.env.FIREBASE_WEB_API_KEY || process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
        if (!apiKey || !isFirebaseConfigured()) return { data: { session: null }, error: { message: 'Auth unavailable', status: 503 } };
        const endpoint = 'https://identitytoolkit.googleapis.com/v1/accounts:';
        const post = (path: string, body: Record<string, unknown>) => fetch(endpoint + path + '?key=' + encodeURIComponent(apiKey), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body), cache: 'no-store',
        });
        let idToken: string;
        try {
          const response = await post('signUp', { email, password, returnSecureToken: true });
          if (!response.ok) {
            const code = await responseErrorCode(response);
            logAuthDiagnostic('sign-up', response.status, code);
            if (response.status >= 500 || code === 'OPERATION_NOT_ALLOWED') return { data: { session: null }, error: { message: 'Registration unavailable', status: 503 } };
            if (code === 'TOO_MANY_ATTEMPTS_TRY_LATER') return { data: { session: null }, error: { message: 'Too many attempts', status: 429 } };
            if (code === 'EMAIL_EXISTS') return { data: { session: null }, error: { code: 'email_exists', message: 'Email already registered', status: 400 } };
            return { data: { session: null }, error: { message: 'Registration failed', status: 400 } };
          }
          const created = await response.json() as { idToken?: string };
          if (!created.idToken) {
            logAuthDiagnostic('sign-up', response.status, 'MISSING_ID_TOKEN');
            return { data: { session: null }, error: { message: 'Registration unavailable', status: 503 } };
          }
          idToken = created.idToken;
        } catch {
          logAuthDiagnostic('sign-up', null, 'FETCH');
          return { data: { session: null }, error: { message: 'Registration unavailable', status: 503 } };
        }
        try {
          const verification = await post('sendOobCode', { requestType: 'VERIFY_EMAIL', idToken });
          if (!verification.ok) {
            logAuthDiagnostic('verify-email', verification.status, await responseErrorCode(verification));
            return { data: { session: null }, error: { message: 'Registration unavailable', status: 503 } };
          }
        } catch {
          logAuthDiagnostic('verify-email', null, 'FETCH');
          return { data: { session: null }, error: { message: 'Registration unavailable', status: 503 } };
        }
        // Set the display name through the same REST surface instead of the
        // Admin SDK (the register path must not depend on the service
        // account). Best-effort: the account and verification email already
        // exist, and getUser falls back to the email when no name is set.
        try {
          const profile = await post('update', { idToken, displayName: name, returnSecureToken: false });
          if (!profile.ok) logAuthDiagnostic('profile', profile.status, await responseErrorCode(profile));
        } catch {
          logAuthDiagnostic('profile', null, 'FETCH');
        }
        return { data: { session: null }, error: null };
      },

      async signOut(_options?: { scope?: string }) {
        // Global sign-out: revoke the verified user's refresh tokens so every
        // other device session dies too, then drop the local cookies.
        try {
          const user = await this.getUser();
          if (user.data.user && isFirebaseConfigured()) {
            const auth = await adminAuth();
            await auth.revokeRefreshTokens(user.data.user.id);
          }
        } catch (e) {
          logAuthDiagnostic('sign-out-revoke', null, adminErrorCode(e));
        }
        store.delete('gymos_session');
        store.delete('sb-token');
        return { error: null };
      },

      async resetPasswordForEmail(email: string, _redirectTo?: string) {
        const apiKey = process.env.FIREBASE_WEB_API_KEY || process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
        if (!apiKey || !isFirebaseConfigured()) return { error: { message: 'Auth unavailable', status: 503 } };
        try {
          const response = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=' + encodeURIComponent(apiKey), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestType: 'PASSWORD_RESET', email }), cache: 'no-store',
          });
          if (!response.ok) {
            const code = await responseErrorCode(response);
            // Existence is never revealed: only throttling and provider
            // outages surface; every other failure looks like success.
            if (response.status === 429 || code === 'TOO_MANY_ATTEMPTS_TRY_LATER') {
              logAuthDiagnostic('password-reset', response.status, code);
              return { error: { message: 'Too many attempts', status: 429 } };
            }
            if (response.status >= 500) {
              logAuthDiagnostic('password-reset', response.status, code);
              return { error: { message: 'Auth unavailable', status: 503 } };
            }
          }
          return { error: null };
        } catch {
          logAuthDiagnostic('password-reset', null, 'FETCH');
          return { error: { message: 'Auth unavailable', status: 503 } };
        }
      },

      async updateUser(data: { password?: string }) {
        const user = await this.getUser();
        if (!user.data.user || !data.password || !isFirebaseConfigured()) return { data: { user: null }, error: { message: 'Unauthorized', status: 401 } };
        if (data.password.length < 12) return { data: { user: null }, error: { message: 'Password too short', status: 400 } };
        try {
          const auth = await adminAuth();
          await auth.updateUser(user.data.user.id, { password: data.password });
          await auth.revokeRefreshTokens(user.data.user.id);
          store.delete('gymos_session');
          return { data: { user: user.data.user }, error: null };
        } catch (e) {
          logAuthDiagnostic('update-user', null, adminErrorCode(e));
          return { data: { user: null }, error: { message: 'Update failed', status: 503 } };
        }
      },

      // The only accepted "code" is a genuine Firebase ID token (minted by an
      // email-link or provider flow); anything else is rejected. The token is
      // verified with revocation checks and exchanged for a session cookie.
      async exchangeCodeForSession(code: string) {
        if (!code || typeof code !== 'string' || !isFirebaseConfigured()) {
          return { data: { session: null }, error: { message: 'Invalid confirmation code', status: 400 } };
        }
        try {
          const auth = await adminAuth();
          let verified;
          try {
            verified = await auth.verifyIdToken(code, true);
          } catch {
            return { data: { session: null }, error: { message: 'Invalid confirmation code', status: 400 } };
          }
          if (!verified.email_verified) return { data: { session: null }, error: { code: 'email_not_confirmed', message: 'Email not verified', status: 403 } };
          const tokenPayload = await auth.createSessionCookie(code, { expiresIn: SESSION_MAX_AGE_SECONDS * 1000 });
          store.set('gymos_session', tokenPayload, sessionCookieOptions);
          return { data: { session: { access_token: tokenPayload } }, error: null };
        } catch (e) {
          logAuthDiagnostic('exchange-code', null, adminErrorCode(e));
          return { data: { session: null }, error: { message: 'Auth unavailable', status: 503 } };
        }
      },
    },
  };
}
