// Edge-safe gymos_session codec for the Supabase auth backend (no Node APIs:
// usable from middleware and the Node runtime alike). The cookie carries both
// tokens because the access token alone expires within the hour while the
// session is meant to live for days.
export type SupabaseCookieSession = { a: string; r: string };

export function encodeSession(access: string, refresh: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ a: access, r: refresh }));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decodeSession(value: string): SupabaseCookieSession | null {
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { a?: unknown; r?: unknown };
    if (typeof parsed?.a === 'string' && typeof parsed?.r === 'string') return { a: parsed.a, r: parsed.r };
  } catch { /* not a supabase session cookie */ }
  return null;
}

// A JWT pair that does not fit the browser's per-cookie 4KB budget must fail
// loudly instead of being truncated into an unverifiable cookie.
export const SESSION_COOKIE_MAX_BYTES = 4000;
