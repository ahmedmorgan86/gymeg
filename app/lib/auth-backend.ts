// Selects the auth provider for this deployment. Unset/empty/'firebase' is the
// legitimate legacy configuration (Firebase Auth; current production). The
// fresh Supabase build sets GYMOS_AUTH_BACKEND=supabase explicitly. Any other
// explicit value fails closed instead of silently choosing a provider.
export function authBackend(): 'firebase' | 'supabase' {
  const choice = process.env.GYMOS_AUTH_BACKEND;
  if (choice === undefined || choice === '' || choice === 'firebase') return 'firebase';
  if (choice === 'supabase') return 'supabase';
  throw new Error('GYMOS_AUTH_BACKEND must be "firebase" or "supabase"');
}

// Server-side auth diagnostics. Log the stage, HTTP status and provider error
// code only: never credentials, tokens, email addresses or display names, so a
// production failure is attributable from the logs without exposing PII.
export function logAuthDiagnostic(stage: string, status: number | null, code: string | null) {
  console.error('[gymeg-auth]', JSON.stringify({ stage, status, code }));
}

// Session cookies live for 5 days on both the stored payload and the browser;
// the Supabase access token inside is rotated by refresh long before that.
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 5;

export const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: SESSION_MAX_AGE_SECONDS,
};
