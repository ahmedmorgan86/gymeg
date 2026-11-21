import { logAuthDiagnostic, sessionCookieOptions } from './auth-backend.ts';
import { decodeSession, encodeSession, SESSION_COOKIE_MAX_BYTES } from './supabase-session-codec.ts';

export type SupabaseRefreshPlan =
  | { action: 'keep' }
  | { action: 'set'; value: string; options: typeof sessionCookieOptions };

// Access tokens are verified server-side on every authenticated call; decoding
// the exp claim here is only a freshness check so middleware refreshes the
// cookie before a page render sees an expired token.
function accessTokenExpiry(access: string): number | null {
  const parts = access.split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1].replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as { exp?: unknown };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

// Pure refresh plan for the writable middleware boundary. Never consumes the
// refresh token unless the access token is actually near expiry. Only two
// outcomes write anything: a successful rotation (set) and a locally
// undecodable cookie (clear — a deterministic local fact, not a race). Any
// provider rejection, including 400/401/403, KEEPS the cookie: an identical
// concurrent request may have already consumed the refresh token and set the
// rotated pair, and a late clear from this request would log the user out.
// A genuinely dead cookie is unusable and harmless; the next sign-in or
// explicit sign-out replaces it.
export async function planSupabaseSessionRefresh(args: {
  url: string;
  key: string;
  cookie: string | undefined;
  now?: number;
}): Promise<SupabaseRefreshPlan> {
  const { url, key, cookie } = args;
  if (!cookie) return { action: 'keep' };
  const session = decodeSession(cookie);
  // Undecodable cookie: keep it too. "Malformed" is judged from this
  // request's snapshot — a concurrent fresh sign-in may already have replaced
  // it, and a stale clear would wipe that new session. An unusable cookie is
  // harmless; the next successful sign-in overwrites it.
  if (!session) {
    logAuthDiagnostic('middleware-refresh', null, 'UNDECODABLE');
    return { action: 'keep' };
  }
  const now = Math.floor((args.now ?? Date.now()) / 1000);
  const exp = accessTokenExpiry(session.a);
  if (exp !== null && exp - now > 60) return { action: 'keep' };
  try {
    const response = await fetch(url.replace(/\/+$/, '') + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { apikey: key, 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: session.r }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    const json = (await response.json().catch(() => null)) as { access_token?: unknown; refresh_token?: unknown } | null;
    if (!response.ok) {
      logAuthDiagnostic('middleware-refresh', response.status, typeof json === 'object' && json && 'error_code' in json ? String((json as { error_code?: unknown }).error_code) : null);
      return { action: 'keep' };
    }
    if (typeof json?.access_token !== 'string' || typeof json?.refresh_token !== 'string') return { action: 'keep' };
    const value = encodeSession(json.access_token, json.refresh_token);
    if (value.length > SESSION_COOKIE_MAX_BYTES) {
      logAuthDiagnostic('middleware-refresh', response.status, 'OVERSIZE');
      return { action: 'keep' };
    }
    return { action: 'set', value, options: sessionCookieOptions };
  } catch {
    logAuthDiagnostic('middleware-refresh', null, 'FETCH');
    return { action: 'keep' };
  }
}
