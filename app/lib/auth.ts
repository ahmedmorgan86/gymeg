import { cookies } from 'next/headers';
import { isFirebaseConfigured, getFirestoreDb } from './firestore-db.ts';

export async function serverAuth() {
  const store = await cookies();
  const sessionToken = store.get('gymos_session')?.value;

  return {
    auth: {
      async getUser() {
        if (!sessionToken) return { data: { user: null }, error: null };
        try {
          if (isFirebaseConfigured()) {
            getFirestoreDb();
            const { getAuth } = await import('firebase-admin/auth');
            const auth = getAuth();
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
        try {
          const response = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + encodeURIComponent(apiKey), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, returnSecureToken: true }),
            cache: 'no-store',
          });
          if (!response.ok) return { data: { session: null }, error: { message: 'Invalid credentials', status: 401 } };
          const result = await response.json() as { idToken?: string; registered?: boolean };
          if (!result.idToken) throw new Error('Missing Firebase ID token');
          getFirestoreDb();
          const { getAuth } = await import('firebase-admin/auth');
          const verified = await getAuth().verifyIdToken(result.idToken, true);
          if (!verified.email_verified) return { data: { session: null }, error: { code: 'email_not_confirmed', message: 'Email not verified', status: 403 } };
          const tokenPayload = await getAuth().createSessionCookie(result.idToken, { expiresIn: 60 * 60 * 24 * 7 * 1000 });
          store.set('gymos_session', tokenPayload, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            path: '/',
            maxAge: 60 * 60 * 24 * 7,
          });
          return { data: { session: { access_token: tokenPayload } }, error: null };
        } catch {
          return { data: { session: null }, error: { message: 'Auth failed', status: 401 } };
        }
      },

      async signUp({ email, password, name }: { email: string; password: string; name: string }) {
        const apiKey = process.env.FIREBASE_WEB_API_KEY || process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
        if (!apiKey || !isFirebaseConfigured()) return { data: { session: null }, error: { message: 'Auth unavailable', status: 503 } };
        try {
          const endpoint = 'https://identitytoolkit.googleapis.com/v1/accounts:';
          const response = await fetch(endpoint + 'signUp?key=' + encodeURIComponent(apiKey), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, returnSecureToken: true }), cache: 'no-store',
          });
          if (!response.ok) return { data: { session: null }, error: { message: 'Registration failed', status: 400 } };
          const result = await response.json() as { idToken?: string; localId?: string };
          if (!result.idToken || !result.localId) throw new Error('Invalid Firebase response');
          getFirestoreDb();
          const { getAuth } = await import('firebase-admin/auth');
          await getAuth().updateUser(result.localId, { displayName: name });
          const verification = await fetch(endpoint + 'sendOobCode?key=' + encodeURIComponent(apiKey), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestType: 'VERIFY_EMAIL', idToken: result.idToken }), cache: 'no-store',
          });
          if (!verification.ok) throw new Error('Verification email failed');
          return { data: { session: null }, error: null };
        } catch { return { data: { session: null }, error: { message: 'Registration unavailable', status: 503 } }; }
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
          if (!response.ok && response.status >= 500) return { error: { message: 'Auth unavailable', status: 503 } };
          return { error: null };
        } catch { return { error: { message: 'Auth unavailable', status: 503 } }; }
      },

      async updateUser(data: { password?: string }) {
        const user = await this.getUser();
        if (!user.data.user || !data.password || !isFirebaseConfigured()) return { data: { user: null }, error: { message: 'Unauthorized', status: 401 } };
        try {
          getFirestoreDb();
          const { getAuth } = await import('firebase-admin/auth');
          await getAuth().updateUser(user.data.user.id, { password: data.password });
          await getAuth().revokeRefreshTokens(user.data.user.id);
          store.delete('gymos_session');
          return { data: { user: user.data.user }, error: null };
        } catch { return { data: { user: null }, error: { message: 'Update failed', status: 503 } }; }
      },

      async exchangeCodeForSession(code: string) {
        void code;
        return { data: { session: null }, error: { message: 'Unsupported auth callback', status: 400 } };
      },
    },
  };
}
