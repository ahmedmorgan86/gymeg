import { cookies } from 'next/headers';
import { isFirebaseConfigured, getFirestoreDb } from './firestore-db.ts';

// Server-side auth diagnostics. Log the stage, HTTP status and provider error
// code only: never credentials, tokens, email addresses or display names, so a
// production failure is attributable from the logs without exposing PII.
function logAuthDiagnostic(stage: string, status: number | null, code: string | null) {
  console.error('[gymeg-auth]', JSON.stringify({ stage, status, code }));
}

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

export async function serverAuth() {
  const store = await cookies();
  const sessionToken = store.get('gymos_session')?.value;

  return {
    auth: {
      async getUser() {
        if (!sessionToken) return { data: { user: null }, error: null };
        try {
          if (isFirebaseConfigured()) {
            const auth = await adminAuth();
            try {
              const decoded = await auth.verifySessionCookie(sessionToken, true);
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
            } catch { return { data: { user: null }, error: null }; }
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
            if (code === 'TOO_MANY_ATTEMPTS_TRY_LATER') return { data: { session: null }, error: { message: 'Too many attempts', status: 429 } };
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
          const tokenPayload = await auth.createSessionCookie(result.idToken, { expiresIn: 60 * 60 * 24 * 7 * 1000 });
          store.set('gymos_session', tokenPayload, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            path: '/',
            maxAge: 60 * 60 * 24 * 7,
          });
          return { data: { session: { access_token: tokenPayload } }, error: null };
        } catch (e) {
          logAuthDiagnostic('sign-in-session', null, adminErrorCode(e));
          return { data: { session: null }, error: { message: 'Auth unavailable', status: 503 } };
        }
      },

      // Establishes the same session as signInWithPassword from a Firebase ID
      // token minted for an external provider (the Google OAuth callback
      // exchanges the Google credential through accounts:signInWithIdp first).
      async signInWithFirebaseToken(idToken: string) {
        if (!idToken || !isFirebaseConfigured()) {
          return { data: { session: null }, error: { message: 'Auth unavailable', status: 503 } };
        }
        try {
          const auth = await adminAuth();
          const verified = await auth.verifyIdToken(idToken, true);
          if (!verified.email_verified) return { data: { session: null }, error: { code: 'email_not_confirmed', message: 'Email not verified', status: 403 } };
          const tokenPayload = await auth.createSessionCookie(idToken, { expiresIn: 60 * 60 * 24 * 7 * 1000 });
          store.set('gymos_session', tokenPayload, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            path: '/',
            maxAge: 60 * 60 * 24 * 7,
          });
          return { data: { session: { access_token: tokenPayload } }, error: null };
        } catch (e) {
          logAuthDiagnostic('firebase-token-sign-in', null, adminErrorCode(e));
          return { data: { session: null }, error: { message: 'Auth unavailable', status: 503 } };
        }
      },

      async signUp({ email, password, name }: { email: string; password: string; name: string }) {
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
        store.delete('gymos_session');
        store.delete('sb-token');
        return { error: null };
      },

      async resetPasswordForEmail(email: string) {
        const apiKey = process.env.FIREBASE_WEB_API_KEY || process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
        if (!apiKey || !isFirebaseConfigured()) return { error: { message: 'Auth unavailable', status: 503 } };
        try {
          const response = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=' + encodeURIComponent(apiKey), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestType: 'PASSWORD_RESET', email }), cache: 'no-store',
          });
          if (!response.ok && response.status >= 500) {
            logAuthDiagnostic('password-reset', response.status, await responseErrorCode(response));
            return { error: { message: 'Auth unavailable', status: 503 } };
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

      async exchangeCodeForSession(code: string) {
        void code;
        return { data: { session: null }, error: { message: 'Unsupported auth callback', status: 400 } };
      },
    },
  };
}
