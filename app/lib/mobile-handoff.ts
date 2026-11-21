import { createHash, randomBytes } from 'node:crypto';
import { rateLimitStoreFor } from './auth-rate-limit.ts';

// Mobile OAuth session handoff. The Android shells run Google sign-in in the
// system browser (Chrome cookies, not the WebView's), so the callback cannot
// reach the WebView by setting a cookie. Instead the callback stores the
// validated session server-side behind a single-use handoff code and redirects
// to a verified App Link; the app then exchanges that code natively.
//
// The exchange is bound to the initiating app instance with a PKCE-style
// verifier/challenge pair: the app keeps a random verifier, sends only its
// SHA-256 challenge with the flow start, and must present the verifier at
// exchange time. An intercepted handoff code is worthless without the
// verifier, which never leaves the app.
//
// Codes are stored hashed (SHA-256), expire after two minutes, and are
// consumed by an atomic DELETE ... RETURNING, so a code works exactly once.
// Neither the code, the verifier, nor the session value is ever logged.

export const HANDOFF_TTL_MS = 2 * 60 * 1000;
export const HANDOFF_CLIENTS = ['android-members', 'android-management'] as const;
export type HandoffClient = (typeof HANDOFF_CLIENTS)[number];

export function isHandoffClient(value: string | undefined | null): value is HandoffClient {
  return value === 'android-members' || value === 'android-management';
}

// The App Link the OAuth callback redirects to, per app. The paths differ so
// Android routes the return deterministically to the app that started the
// flow even when both shells are installed (the client query parameter alone
// does not influence Android link routing).
export function handoffReturnPath(client: HandoffClient): string {
  return '/auth/mobile/callback/' + (client === 'android-members' ? 'members' : 'management');
}

const sha256Hex = (input: string) => createHash('sha256').update(input).digest('hex');
const sha256Base64Url = (input: string) => createHash('sha256').update(input).digest('base64url');

// base64url(SHA-256) is exactly 43 characters.
export const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newHandoffVerifier(): string {
  return randomBytes(32).toString('base64url');
}

export function handoffChallenge(verifier: string): string {
  return sha256Base64Url(verifier);
}

type HandoffRow = { session: string; app_challenge: string; client: string };

// In-memory store for tests and local development (rateLimitStoreFor returns
// 'local' there). Production uses the shared Postgres table; a Firestore
// persistence backend has no handoff store because the Android shells ship
// only with the Supabase build.
const localRows = new Map<string, HandoffRow & { expires_at: number }>();

type PgClient = { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, string>> }> };

async function pg(work: (client: PgClient) => Promise<void>): Promise<void> {
  const { getPool } = await import('./database.ts');
  const client = await getPool().connect();
  try {
    await work(client as unknown as PgClient);
  } finally {
    client.release();
  }
}

// Persists a handoff and returns the code to embed in the App Link redirect.
// sessionValue is the exact encoded gymos_session cookie value; it is never
// written anywhere but the handoff row, which the exchange deletes on use.
export async function createHandoff(sessionValue: string, client: HandoffClient, appChallenge: string): Promise<string> {
  const code = newHandoffVerifier();
  const codeHash = sha256Hex(code);
  const expiresAt = new Date(Date.now() + HANDOFF_TTL_MS);
  const store = rateLimitStoreFor();
  if (store === 'postgres') {
    await pg(async (c) => {
      // Opportunistic sweep so expired rows never accumulate unbounded.
      await c.query('DELETE FROM gymos.auth_handoff_codes WHERE expires_at <= now()');
      await c.query(
        'INSERT INTO gymos.auth_handoff_codes (code_hash, session, app_challenge, client, expires_at) VALUES ($1,$2,$3,$4,$5)',
        [codeHash, sessionValue, appChallenge, client, expiresAt],
      );
    });
  } else if (store === 'local') {
    const now = Date.now();
    for (const [key, row] of localRows) if (row.expires_at <= now) localRows.delete(key);
    localRows.set(codeHash, { session: sessionValue, app_challenge: appChallenge, client, expires_at: now + HANDOFF_TTL_MS });
  } else {
    throw new Error('mobile handoff is unavailable on the Firestore persistence backend');
  }
  return code;
}

// Atomically consumes a handoff. Every predicate - code hash, challenge,
// client, expiry - lives INSIDE the single DELETE, so a wrong proof does not
// burn the legitimate app's code: only a fully matching presentation deletes
// the row. Concurrent correct exchanges can still succeed at most once.
// Returns null for unknown, expired, or already-used codes and for any
// verifier/client mismatch, without distinguishing which check failed.
export async function consumeHandoff(code: string, verifier: string, client: HandoffClient): Promise<string | null> {
  if (!CHALLENGE_PATTERN.test(code) || !CHALLENGE_PATTERN.test(verifier)) return null;
  const codeHash = sha256Hex(code);
  const challenge = handoffChallenge(verifier);
  const store = rateLimitStoreFor();
  if (store === 'postgres') {
    let session: string | null = null;
    await pg(async (c) => {
      const result = await c.query(
        'DELETE FROM gymos.auth_handoff_codes WHERE code_hash = $1 AND app_challenge = $2 AND client = $3 AND expires_at > now() RETURNING session',
        [codeHash, challenge, client],
      );
      session = result.rows[0]?.session ?? null;
    });
    return session;
  }
  if (store === 'local') {
    const candidate = localRows.get(codeHash);
    if (!candidate || candidate.expires_at <= Date.now() || candidate.client !== client || candidate.app_challenge !== challenge) return null;
    localRows.delete(codeHash);
    return candidate.session;
  }
  return null;
}

// Test-only introspection/reset for the local store.
export const __handoffTest = {
  size: () => localRows.size,
  clear: () => localRows.clear(),
};
