import { logAuthDiagnostic, sessionCookieOptions } from './auth-backend.ts';
import { decodeSession, encodeSession, SESSION_COOKIE_MAX_BYTES } from './supabase-session-codec.ts';

export type SupabaseRefreshPlan =
  | { action: 'keep' }
  | { action: 'set'; value: string; options: typeof sessionCookieOptions }
  | { action: 'clear' };

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
// refresh token unless the access token is actually near expiry; a dead
// refresh token clears the cookie, a transient provider failure keeps it so a
// concurrent successful rotation is never clobbered.
export async function planSupabaseSessionRefresh(args: {
  url: string;
  key: string;
  cookie: string | undefined;
  now?: number;
}): Promise<SupabaseRefreshPlan> {
  const { url, key, cookie } = args;
  if (!cookie) return { action: 'keep' };
  const session = decodeSession(cookie);
  if (!session) return { action: 'clear' };
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
      // Dead refresh token: clear. Transient provider failure: keep, so a
      // concurrent request that already rotated is not logged out.
      if (response.status === 400 || response.status === 401 || response.status === 403) return { action: 'clear' };
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
