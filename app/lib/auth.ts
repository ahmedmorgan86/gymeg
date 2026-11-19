import { cookies } from 'next/headers';
import { getAuth } from 'firebase-admin/auth';
import { isFirebaseConfigured, getFirestoreDb } from './firestore-db.ts';

export async function serverAuth() {
  const store = await cookies();
  const sessionToken = store.get('gymos_session')?.value || store.get('sb-token')?.value;

  return {
    auth: {
      async getUser() {
        if (!sessionToken) {
          if (process.env.NODE_ENV === 'test' || process.env.GYMOS_ALLOW_DB_MOCK === '1') {
            return {
              data: { user: { id: 'owner', email: 'owner@example.invalid', user_metadata: { name: 'Owner' } } },
              error: null,
            };
          }
          return { data: { user: null }, error: null };
        }

        try {
          if (isFirebaseConfigured()) {
            getFirestoreDb(); // ensure admin app is initialized
            const auth = getAuth();
            try {
              const decoded = await auth.verifySessionCookie(sessionToken, true);
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
            } catch {
              const decoded = await auth.verifyIdToken(sessionToken);
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
          }

          const parsed = JSON.parse(Buffer.from(sessionToken, 'base64url').toString('utf8'));
          return {
            data: {
              user: {
                id: parsed.uid || parsed.id || 'owner',
                email: parsed.email || 'owner@example.com',
                user_metadata: { name: parsed.name || 'Owner' },
              },
            },
            error: null,
          };
        } catch (e) {
          return { data: { user: null }, error: e };
        }
      },

      async signInWithPassword({ email, password }: { email: string; password: string }) {
        if (!email || !password) {
          return { data: { session: null }, error: { message: 'Invalid credentials', status: 400 } };
        }

        try {
          const tokenPayload = Buffer.from(
            JSON.stringify({
              uid: email.replace(/[^a-zA-Z0-9_-]/g, '_'),
              email,
              name: email.split('@')[0],
              iat: Date.now(),
            })
          ).toString('base64url');

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

      async signOut(_options?: { scope?: string }) {
        store.delete('gymos_session');
        store.delete('sb-token');
        return { error: null };
      },

      async resetPasswordForEmail(email: string, _options?: { redirectTo?: string }) {
        if (isFirebaseConfigured()) {
          try {
            getFirestoreDb();
            const link = await getAuth().generatePasswordResetLink(email);
            return { error: null, link };
          } catch (err: any) {
            return { error: { message: err?.message || 'reset_failed', status: 400 } };
          }
        }
        return { error: null };
      },

      async updateUser(_data: { password?: string }) {
        return { data: { user: null }, error: null };
      },

      async exchangeCodeForSession(code: string) {
        if (code) {
          store.set('gymos_session', code, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'lax',
            path: '/',
          });
          return { data: { session: { access_token: code } }, error: null };
        }
        return { data: { session: null }, error: { message: 'Invalid code' } };
      },
    },
  };
}
