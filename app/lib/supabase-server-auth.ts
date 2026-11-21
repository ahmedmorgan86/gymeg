import type { cookies } from 'next/headers';
import { logAuthDiagnostic, sessionCookieOptions } from './auth-backend.ts';
import { decodeSession, encodeSession, SESSION_COOKIE_MAX_BYTES } from './supabase-session-codec.ts';

type CookieStore = Awaited<ReturnType<typeof cookies>>;

// Supabase Auth (GoTrue) provider for the fresh build. Direct REST calls with
// the publishable key only — no service/secret key and no SDK dependency.
// The publishable key is public by design; every call is subject to the
// project's auth configuration, and user verification always happens
// server-side at the auth server, never by decoding a token locally.

function supabaseConfig(): { url: string; key: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ''), key };
}

type GoTrueResult =
  | { ok: true; status: number; json: Record<string, unknown> }
  | { ok: false; status: number; code: string | null };

async function gotrue(
  config: { url: string; key: string },
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {},
): Promise<GoTrueResult> {
  try {
    const response = await fetch(config.url + '/auth/v1' + path, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers: {
        apikey: config.key,
        'content-type': 'application/json',
        ...(opts.token ? { authorization: 'Bearer ' + opts.token } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (response.ok) return { ok: true, status: response.status, json: json ?? {} };
    const code =
      typeof json?.error_code === 'string' ? json.error_code
      : typeof json?.error === 'string' ? json.error
      : typeof json?.code === 'string' ? json.code
      : null;
    return { ok: false, status: response.status, code };
  } catch {
    return { ok: false, status: 0, code: 'FETCH' };
  }
}

type AuthUser = { id: string; email?: string; is_anonymous?: boolean; user_metadata?: Record<string, unknown> };

// Shape the GoTrue user into the AuthUser the rest of the app consumes.
function toAuthUser(user: Record<string, unknown> | null): AuthUser | null {
  if (!user || typeof user.id !== 'string') return null;
  return {
    id: user.id,
    email: typeof user.email === 'string' ? user.email : undefined,
    is_anonymous: user.is_anonymous === true,
    user_metadata: user.user_metadata && typeof user.user_metadata === 'object' ? user.user_metadata as Record<string, unknown> : {},
  };
}

// Mirrors the Firebase backend's email_verified gate: unconfirmed accounts
// never open a session.
function confirmedUser(user: Record<string, unknown> | undefined | null): Record<string, unknown> | null {
  if (!user || typeof user.email_confirmed_at !== 'string' || !user.email_confirmed_at) return null;
  return user;
}

const UNAVAILABLE = { message: 'Auth unavailable', status: 503 } as const;
const EMAIL_NOT_CONFIRMED = { code: 'email_not_confirmed', message: 'Email not verified', status: 403 } as const;

type SessionPayload = { access_token?: unknown; refresh_token?: unknown; user?: Record<string, unknown> };

// Persists a token pair from a grant response. Fails (no cookie) when the
// pair is missing or the encoded value would exceed the browser cookie
// budget, and refuses to open a session for an unconfirmed email unless the
// flow explicitly allows it (account recovery).
function openSession(store: CookieStore, payload: SessionPayload, opts: { allowUnconfirmed?: boolean } = {}): { access_token: string } | { error: typeof EMAIL_NOT_CONFIRMED | typeof UNAVAILABLE } | null {
  if (typeof payload.access_token !== 'string' || typeof payload.refresh_token !== 'string') return null;
  // A session is only opened for a well-formed email identity: GoTrue always
  // returns the user on a token grant, so a missing or malformed one means
  // the response is not what it claims to be.
  const user = payload.user;
  if (!user || typeof user.id !== 'string' || typeof user.email !== 'string') {
    logAuthDiagnostic('session-cookie', null, 'MALFORMED_USER');
    return { error: UNAVAILABLE };
  }
  if (!opts.allowUnconfirmed && !user.email_confirmed_at) {
    return { error: EMAIL_NOT_CONFIRMED };
  }
  const value = encodeSession(payload.access_token, payload.refresh_token);
  if (value.length > SESSION_COOKIE_MAX_BYTES) {
    logAuthDiagnostic('session-cookie', null, 'OVERSIZE');
    return { error: UNAVAILABLE };
  }
  store.set('gymos_session', value, sessionCookieOptions);
  return { access_token: payload.access_token };
}

export function supabaseServerAuth(store: CookieStore) {
  // Cookies are read fresh on every call: a rotation by middleware or by an
  // earlier method on this same object must never leave a stale token behind.
  const readSession = () => {
    const value = store.get('gymos_session')?.value;
    return value ? { raw: value, tokens: decodeSession(value) } : { raw: undefined, tokens: null };
  };
  const readMobileToken = () => store.get('sb-token')?.value;

  async function currentUser(): Promise<AuthUser | null> {
    const config = supabaseConfig();
    if (!config) return null;
    const mobileToken = readMobileToken();
    const { tokens } = readSession();
    if (mobileToken && !tokens) {
      const mobile = await gotrue(config, '/user', { token: mobileToken });
      // GET /user returns the raw user object, not { user }.
      return toAuthUser(mobile.ok ? confirmedUser(mobile.json) : null);
    }
    if (!tokens) return null;
    const first = await gotrue(config, '/user', { token: tokens.a });
    if (first.ok) return toAuthUser(confirmedUser(first.json));
    // Expired or rejected access token: rotation belongs exclusively to the
    // middleware refresh boundary (middleware.ts). Rotating here would consume
    // the single-use refresh token in a context that may not be able to
    // persist the new pair, and a stale clear/set from this request could
    // clobber a concurrent request's successful rotation — races a per-request
    // cookie comparison cannot detect. Read-only and writable contexts alike
    // therefore just report "no user" and let the boundary refresh.
    return null;
  }

  return {
    auth: {
      async getUser() {
        const user = await currentUser();
        return { data: { user }, error: null };
      },

      async signInWithPassword({ email, password }: { email: string; password: string }) {
        if (!email || !password) return { data: { session: null }, error: { message: 'Invalid credentials', status: 400 } };
        const config = supabaseConfig();
        if (!config) return { data: { session: null }, error: UNAVAILABLE };
        const result = await gotrue(config, '/token?grant_type=password', { body: { email, password } });
        if (!result.ok) {
          logAuthDiagnostic('sign-in', result.status, result.code);
          if (result.status >= 500 || result.status === 0) return { data: { session: null }, error: UNAVAILABLE };
          if (result.status === 429) return { data: { session: null }, error: { message: 'Too many attempts', status: 429 } };
          if (result.code === 'email_not_confirmed') return { data: { session: null }, error: EMAIL_NOT_CONFIRMED };
          return { data: { session: null }, error: { code: 'invalid_credentials', message: 'Invalid credentials', status: 401 } };
        }
        const session = openSession(store, result.json);
        if (!session) {
          logAuthDiagnostic('sign-in-session', result.status, 'MISSING_TOKENS');
          return { data: { session: null }, error: UNAVAILABLE };
        }
        if ('error' in session) return { data: { session: null }, error: session.error };
        return { data: { session }, error: null };
      },

      // Google sign-in: the app's own OAuth flow (state cookie, code exchange
      // at Google) produces a Google ID token, exchanged here for a Supabase
      // session. Requires the Google provider enabled with this client's ID.
      async signInWithIdToken(provider: 'google', idToken: string) {
        const config = supabaseConfig();
        if (!config || !idToken) return { data: { session: null }, error: UNAVAILABLE };
        const result = await gotrue(config, '/token?grant_type=id_token', { body: { provider, id_token: idToken } });
        if (!result.ok) {
          logAuthDiagnostic('id-token-sign-in', result.status, result.code);
          if (result.status >= 500 || result.status === 0) return { data: { session: null }, error: UNAVAILABLE };
          if (result.code === 'email_not_confirmed') return { data: { session: null }, error: EMAIL_NOT_CONFIRMED };
          return { data: { session: null }, error: { message: 'Invalid credentials', status: 401 } };
        }
        const session = openSession(store, result.json);
        if (!session) {
          logAuthDiagnostic('id-token-session', result.status, 'MISSING_TOKENS');
          return { data: { session: null }, error: UNAVAILABLE };
        }
        if ('error' in session) return { data: { session: null }, error: session.error };
        return { data: { session }, error: null };
      },

      // Firebase-backend-only entry point; the Google callback route branches
      // on authBackend() before calling it, so it never runs on Supabase.
      async signInWithFirebaseToken(_idToken: string) {
        return { data: { session: null }, error: { message: 'Invalid credentials', status: 400 } };
      },

      async signUp({ email, password, name }: { email: string; password: string; name: string }) {
        const config = supabaseConfig();
        if (!config) return { data: { session: null }, error: { message: 'Registration unavailable', status: 503 } };
        const result = await gotrue(config, '/signup', { body: { email, password, data: { name } } });
        if (!result.ok) {
          logAuthDiagnostic('sign-up', result.status, result.code);
          if (result.status >= 500 || result.status === 0) return { data: { session: null }, error: { message: 'Registration unavailable', status: 503 } };
          if (result.status === 429) return { data: { session: null }, error: { message: 'Too many attempts', status: 429 } };
          if (result.code === 'user_already_exists' || result.code === 'email_exists') return { data: { session: null }, error: { code: 'email_exists', message: 'Email already registered', status: 400 } };
          if (result.code === 'weak_password') return { data: { session: null }, error: { message: 'Password too short', status: 400 } };
          return { data: { session: null }, error: { message: 'Registration failed', status: 400 } };
        }
        // With email confirmation on, GoTrue sends the verification mail and
        // returns no session; the UI then shows the "confirmation sent" state.
        const session = openSession(store, result.json);
        if (session && 'error' in session) return { data: { session: null }, error: session.error };
        return { data: { session: session || null }, error: null };
      },

      async signOut(_options?: { scope?: string }) {
        const config = supabaseConfig();
        const { tokens } = readSession();
        const token = tokens?.a ?? readMobileToken();
        let failure: { message: string; status: number } | null = null;
        if (token) {
          if (!config) {
            failure = { message: 'Sign-out revocation unavailable', status: 503 };
          } else {
            // Global sign-out: the auth server revokes every refresh token for
            // this user, so other devices die too; then drop the local cookies.
            // Uses the freshest cookie, so a rotated access token is what gets
            // revoked. Any provider failure is reported, never masked.
            const result = await gotrue(config, '/logout?scope=global', { token, body: {} });
            if (!result.ok) {
              logAuthDiagnostic('sign-out-revoke', result.status, result.code);
              failure = { message: 'Sign-out revocation failed', status: result.status >= 500 || result.status === 0 ? 503 : result.status };
            }
          }
        }
        if (failure) {
          // Keep both cookies: the session is still server-side valid, and
          // discarding them would lose the ability to retry the revocation.
          return { error: failure };
        }
        store.delete('gymos_session');
        store.delete('sb-token');
        return { error: null };
      },

      async resetPasswordForEmail(email: string) {
        const config = supabaseConfig();
        if (!config) return { error: UNAVAILABLE };
        const result = await gotrue(config, '/recover', { body: { email } });
        if (!result.ok) {
          // Existence is never revealed: only throttling and provider outages
          // surface; every other failure looks like success.
          if (result.status === 429) {
            logAuthDiagnostic('password-reset', result.status, result.code);
            return { error: { message: 'Too many attempts', status: 429 } };
          }
          if (result.status >= 500 || result.status === 0) {
            logAuthDiagnostic('password-reset', result.status, result.code);
            return { error: UNAVAILABLE };
          }
        }
        return { error: null };
      },

      async updateUser(data: { password?: string }) {
        if (!data.password) return { data: { user: null }, error: { message: 'Unauthorized', status: 401 } };
        if (data.password.length < 12) return { data: { user: null }, error: { message: 'Password too short', status: 400 } };
        const user = await this.getUser();
        if (!user.data.user) return { data: { user: null }, error: { message: 'Unauthorized', status: 401 } };
        const config = supabaseConfig();
        // Read after getUser(): a rotation inside it rewrites the cookie, so a
        // token captured before could already be expired.
        const { tokens } = readSession();
        const token = tokens?.a ?? readMobileToken();
        if (!config || !token) return { data: { user: null }, error: { message: 'Update failed', status: 503 } };
        const result = await gotrue(config, '/user', { method: 'PUT', token, body: { password: data.password } });
        if (!result.ok) {
          logAuthDiagnostic('update-user', result.status, result.code);
          return { data: { user: null }, error: { message: 'Update failed', status: 503 } };
        }
        const revoked = await gotrue(config, '/logout?scope=global', { token, body: {} });
        store.delete('gymos_session');
        store.delete('sb-token');
        if (!revoked.ok) {
          logAuthDiagnostic('update-user-revoke', revoked.status, revoked.code);
          return { data: { user: null }, error: { message: 'Session revocation failed', status: 503 } };
        }
        return { data: { user: user.data.user }, error: null };
      },

      // Email confirmation / recovery links. Only explicit supported types are
      // accepted: 'signup' (and 'email_change') open a normal confirmed
      // session; 'recovery' opens a session allowed to set a new password even
      // before the address is confirmed. Anything else is rejected.
      async verifyEmailToken(tokenHash: string, type: string) {
        const config = supabaseConfig();
        const allowedTypes = new Set(['signup', 'recovery', 'email_change', 'magiclink']);
        if (!config || !tokenHash || !allowedTypes.has(type)) return { data: { session: null }, error: { message: 'Invalid confirmation code', status: 400 } };
        const result = await gotrue(config, '/verify', { body: { token_hash: tokenHash, type } });
        if (!result.ok) {
          logAuthDiagnostic('verify-token', result.status, result.code);
          return { data: { session: null }, error: { message: 'Invalid confirmation code', status: 400 } };
        }
        const session = openSession(store, result.json, { allowUnconfirmed: type === 'recovery' });
        if (!session || 'error' in session) return { data: { session: null }, error: session && 'error' in session ? session.error : UNAVAILABLE };
        return { data: { session }, error: null };
      },

      async exchangeCodeForSession(code: string) {
        const config = supabaseConfig();
        if (!config || !code || typeof code !== 'string') return { data: { session: null }, error: { message: 'Invalid confirmation code', status: 400 } };
        const verifier = store.get('gymos_pkce_verifier')?.value;
        if (!verifier) return { data: { session: null }, error: { message: 'Invalid confirmation code', status: 400 } };
        const result = await gotrue(config, '/token?grant_type=pkce', { body: { auth_code: code, code_verifier: verifier } });
        store.delete('gymos_pkce_verifier');
        if (!result.ok) {
          logAuthDiagnostic('exchange-code', result.status, result.code);
          return { data: { session: null }, error: { message: 'Invalid confirmation code', status: 400 } };
        }
        const session = openSession(store, result.json);
        if (!session || 'error' in session) return { data: { session: null }, error: session && 'error' in session ? session.error : UNAVAILABLE };
        return { data: { session }, error: null };
      },

      // Supabase-backend-only entry points; the routes branch on
      // authBackend() before calling them, so these never run on Firebase.
      // (Kept on the Firebase provider instead; see firebase-server-auth.ts.)
    },
  };
}
