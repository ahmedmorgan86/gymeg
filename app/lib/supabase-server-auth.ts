import type { cookies } from 'next/headers';
import { logAuthDiagnostic, sessionCookieOptions } from './auth-backend.ts';

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

// The session cookie carries both tokens as base64url(JSON): the access token
// alone would expire within an hour, while the cookie (and the user's session)
// is meant to live for days. Refresh rotation happens inside getUser.
function encodeSession(access: string, refresh: string): string {
  return Buffer.from(JSON.stringify({ a: access, r: refresh }), 'utf8').toString('base64url');
}
function decodeSession(value: string): { a: string; r: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { a?: unknown; r?: unknown };
    if (typeof parsed?.a === 'string' && typeof parsed?.r === 'string') return { a: parsed.a, r: parsed.r };
  } catch { /* not a supabase session cookie */ }
  return null;
}

type SessionPayload = { access_token?: unknown; refresh_token?: unknown; user?: Record<string, unknown> };

function setSession(store: CookieStore, payload: SessionPayload): { access_token: string } | null {
  if (typeof payload.access_token !== 'string' || typeof payload.refresh_token !== 'string') return null;
  store.set('gymos_session', encodeSession(payload.access_token, payload.refresh_token), sessionCookieOptions);
  return { access_token: payload.access_token };
}

// Mirrors the Firebase backend's email_verified gate: unconfirmed accounts
// never open a session.
function confirmedUser(user: Record<string, unknown> | undefined | null): Record<string, unknown> | null {
  if (!user || typeof user.email_confirmed_at !== 'string' || !user.email_confirmed_at) return null;
  return user;
}

const UNAVAILABLE = { message: 'Auth unavailable', status: 503 } as const;

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

export function supabaseServerAuth(store: CookieStore) {
  const sessionToken = store.get('gymos_session')?.value;
  // Mobile clients authenticate with a Supabase access token in this cookie.
  const mobileToken = store.get('sb-token')?.value;

  // Verifies the access token at the auth server; on expiry, rotates the
  // session through the refresh token exactly once.
  async function currentUser(): Promise<AuthUser | null> {
    const config = supabaseConfig();
    if (!config) return null;
    if (mobileToken && !sessionToken) {
      const mobile = await gotrue(config, '/user', { token: mobileToken });
      return toAuthUser(mobile.ok ? confirmedUser(mobile.json.user as Record<string, unknown>) : null);
    }
    const session = sessionToken ? decodeSession(sessionToken) : null;
    if (!session) return null;
    const first = await gotrue(config, '/user', { token: session.a });
    if (first.ok) return toAuthUser(confirmedUser(first.json.user as Record<string, unknown>));
    if (first.status !== 401 && first.status !== 403) return null;
    const rotated = await gotrue(config, '/token?grant_type=refresh_token', { body: { refresh_token: session.r } });
    if (!rotated.ok) {
      if (rotated.status === 400 || rotated.status === 401 || rotated.status === 403) store.delete('gymos_session');
      return null;
    }
    if (!setSession(store, rotated.json)) return null;
    return toAuthUser(confirmedUser(rotated.json.user as Record<string, unknown>));
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
          if (result.code === 'email_not_confirmed') return { data: { session: null }, error: { code: 'email_not_confirmed', message: 'Email not verified', status: 403 } };
          return { data: { session: null }, error: { code: 'invalid_credentials', message: 'Invalid credentials', status: 401 } };
        }
        const session = setSession(store, result.json);
        if (!session) {
          logAuthDiagnostic('sign-in-session', result.status, 'MISSING_TOKENS');
          return { data: { session: null }, error: UNAVAILABLE };
        }
        return { data: { session }, error: null };
      },

      // Firebase-backend-only entry point; the Google callback route branches
      // on authBackend() before calling it, so it never runs on Supabase.
      async signInWithFirebaseToken(_idToken: string) {
        return { data: { session: null }, error: { message: 'Invalid credentials', status: 400 } };
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
          if (result.code === 'email_not_confirmed') return { data: { session: null }, error: { code: 'email_not_confirmed', message: 'Email not verified', status: 403 } };
          return { data: { session: null }, error: { message: 'Invalid credentials', status: 401 } };
        }
        const session = setSession(store, result.json);
        if (!session) {
          logAuthDiagnostic('id-token-session', result.status, 'MISSING_TOKENS');
          return { data: { session: null }, error: UNAVAILABLE };
        }
        return { data: { session }, error: null };
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
        const session = setSession(store, result.json);
        return { data: { session }, error: null };
      },

      async signOut(_options?: { scope?: string }) {
        const config = supabaseConfig();
        const session = sessionToken ? decodeSession(sessionToken) : null;
        const token = session?.a ?? mobileToken;
        if (config && token) {
          // Global sign-out: the auth server revokes every refresh token for
          // this user, so other devices die too; then drop the local cookies.
          const result = await gotrue(config, '/logout?scope=global', { token, body: {} });
          if (!result.ok) logAuthDiagnostic('sign-out-revoke', result.status, result.code);
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
        const session = sessionToken ? decodeSession(sessionToken) : null;
        const token = session?.a ?? mobileToken;
        if (!config || !token) return { data: { user: null }, error: { message: 'Update failed', status: 503 } };
        const result = await gotrue(config, '/user', { method: 'PUT', token, body: { password: data.password } });
        if (!result.ok) {
          logAuthDiagnostic('update-user', result.status, result.code);
          return { data: { user: null }, error: { message: 'Update failed', status: 503 } };
        }
        await gotrue(config, '/logout?scope=global', { token, body: {} });
        store.delete('gymos_session');
        return { data: { user: user.data.user }, error: null };
      },

      // Email confirmation / recovery links. The reliable server-side form is
      // the token_hash link (works from any device, no PKCE verifier needed);
      // a PKCE auth code is accepted when its verifier cookie exists (flows
      // started server-side in this browser). Anything else is rejected.
      async verifyEmailToken(tokenHash: string, type: string) {
        const config = supabaseConfig();
        if (!config || !tokenHash || !type) return { data: { session: null }, error: { message: 'Invalid confirmation code', status: 400 } };
        const result = await gotrue(config, '/verify', { body: { token_hash: tokenHash, type } });
        if (!result.ok) {
          logAuthDiagnostic('verify-token', result.status, result.code);
          return { data: { session: null }, error: { message: 'Invalid confirmation code', status: 400 } };
        }
        const session = setSession(store, result.json);
        if (!session) return { data: { session: null }, error: UNAVAILABLE };
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
        const session = setSession(store, result.json);
        if (!session) return { data: { session: null }, error: UNAVAILABLE };
        return { data: { session }, error: null };
      },
    },
  };
}
