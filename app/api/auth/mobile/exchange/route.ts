import { SESSION_MAX_AGE_SECONDS } from '../../../../lib/auth-backend';
import { consumeHandoff, isHandoffClient, CHALLENGE_PATTERN } from '../../../../lib/mobile-handoff.ts';

export const dynamic = 'force-dynamic';

// Android session handoff exchange. The app receives a single-use code via a
// verified App Link redirect and trades it, together with the verifier whose
// SHA-256 challenge started the flow, for the gymos_session cookie. The code
// is consumed atomically, expires after two minutes, and is worthless without
// the verifier, which never leaves the app. Codes, verifiers, and session
// values are never logged.

const fail = (status: number) =>
  new Response(JSON.stringify({ error: 'handoff_failed' }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export async function POST(request: Request) {
  let body: { code?: unknown; verifier?: unknown; client?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail(400);
  }
  const { code, verifier, client } = body ?? {};
  if (
    typeof code !== 'string' || typeof verifier !== 'string' || typeof client !== 'string' ||
    !CHALLENGE_PATTERN.test(code) || !CHALLENGE_PATTERN.test(verifier) || !isHandoffClient(client)
  ) {
    return fail(400);
  }
  let session: string | null = null;
  try {
    session = await consumeHandoff(code, verifier, client);
  } catch {
    // Store outage: retryable, nothing consumed by the caller's perspective.
    return fail(503);
  }
  if (!session) return fail(401);

  // Same attributes as the browser session cookie (sessionCookieOptions):
  // HttpOnly + SameSite=Lax + Path=/, Secure in production. The app copies
  // this header into the WebView's CookieManager verbatim.
  const parts = [
    `gymos_session=${session}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  return new Response(null, {
    status: 204,
    headers: { 'set-cookie': parts.join('; '), 'cache-control': 'no-store' },
  });
}
