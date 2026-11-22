import { createHash } from 'node:crypto';
import { requestClientIp } from './request-origin';

// Store selection mirrors the persistence backend without importing modules at
// load time: the limiter is imported by test harnesses and cold auth routes,
// and must not drag the firebase-admin or pg chain in unless the shared store
// is actually used. Firestore counters only when Firestore is the persistence
// backend; Postgres when GYMOS_DATA_BACKEND=postgres (or any deployment with
// DATABASE_URL and no Firebase envs); otherwise a per-process Map.
export type RateLimitStore = 'firestore' | 'postgres' | 'local';

// Pure selection, exported for tests. Tests and local development always use
// the per-process Map regardless of backend envs.
export function rateLimitStoreFor(env: Record<string, string | undefined> = process.env): RateLimitStore {
  if (env.NODE_ENV === 'test') return 'local';
  // Mirror isFirestorePersistence(): only unset/empty or "postgres" is a
  // valid GYMOS_DATA_BACKEND. Anything else is a typo or drift and must stop
  // the process, never silently pick a backend.
  const backend = env.GYMOS_DATA_BACKEND;
  if (backend !== undefined && backend !== '' && backend !== 'postgres') {
    throw new Error('GYMOS_DATA_BACKEND must be "postgres" or unset');
  }
  if (backend === 'postgres') {
    if (env.DATABASE_URL) return 'postgres';
    // Explicit Postgres without a connection string must not degrade to a
    // per-process Map in production, where counters would stop being shared.
    if (env.NODE_ENV === 'production') {
      throw new Error('GYMOS_DATA_BACKEND=postgres requires DATABASE_URL');
    }
    return 'local';
  }
  const firebase = Boolean(
    env.GYMEG_FIREBASE_SERVICE_ACCOUNT ||
    env.FIREBASE_PROJECT_ID ||
    env.NEXT_PUBLIC_FIREBASE_PROJECT_ID
  );
  if (firebase) return 'firestore';
  if (env.DATABASE_URL) return 'postgres';
  // A production process with no shared store must stop, never fall back to a
  // per-process Map: limiter counters and mobile-handoff rows would silently
  // stop being shared across instances.
  if (env.NODE_ENV === 'production') {
    throw new Error('Production requires a shared rate-limit store (DATABASE_URL or Firebase persistence)');
  }
  return 'local';
}

// Rate limiting for unauthenticated auth endpoints.
//
// Two buckets are consumed per call:
//   1. per (scope, IP, email) with the caller's limit - a targeted victim
//      cannot be hammered through one email address;
//   2. per (scope, IP) with IP_LIMIT per window - one client cannot spray
//      attempts across many email addresses either.
//
// Storage: counters live in the shared persistence backend (Firestore
// `auth_rate_limits` collection, or the gymos.auth_rate_limits table on
// Postgres deployments) so every serverless instance enforces the same limit.
// Without a shared store (local development and tests) a per-process Map is
// used, which is sufficient for a single Node instance.
// A store outage fails closed but retryable (logged): the decision carries
// outage=true and routes answer 503 with Retry-After, so a counter-store
// outage never silently disables rate limiting.

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 5000;
const IP_LIMIT = 30;

export type RateLimitDecision = { allowed: boolean; retryAfter: number; outage?: boolean };

type Bucket = { hits: number; resetAt: number };
const buckets = new Map<string, Bucket>();

function prune(now: number) {
  if (buckets.size < MAX_ENTRIES) return;
  for (const [key, bucket] of buckets) if (now >= bucket.resetAt) buckets.delete(key);
  while (buckets.size >= MAX_ENTRIES) {
    const oldest = buckets.keys().next().value;
    if (oldest === undefined) break;
    buckets.delete(oldest);
  }
}

function consumeLocal(key: string, limit: number, windowMs: number, now: number): RateLimitDecision {
  prune(now);
  let bucket = buckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { hits: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.hits++;
  if (bucket.hits > limit) return { allowed: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  return { allowed: true, retryAfter: 0 };
}

const docId = (key: string) => createHash('sha256').update(key).digest('hex');

async function consumeShared(key: string, limit: number, windowMs: number, now: number): Promise<RateLimitDecision> {
  const { getFirestoreDb } = await import('./firestore-db.ts');
  const db = getFirestoreDb();
  const ref = db.collection('auth_rate_limits').doc(docId(key));
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const data = snap.data() as { hits?: number; reset_at?: string } | undefined;
    const resetAt = data?.reset_at ? Date.parse(data.reset_at) : 0;
    if (!data || !Number.isFinite(resetAt) || now >= resetAt) {
      tx.set(ref, { hits: 1, reset_at: new Date(now + windowMs).toISOString() });
      return { allowed: true, retryAfter: 0 };
    }
    const hits = (data.hits ?? 0) + 1;
    tx.update(ref, { hits });
    if (hits > limit) return { allowed: false, retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1000)) };
    return { allowed: true, retryAfter: 0 };
  });
}

async function consumePostgres(key: string, limit: number, windowMs: number, now: number): Promise<RateLimitDecision> {
  const { getPool } = await import('./database.ts');
  const id = docId(key);
  // One atomic upsert. INSERT ... ON CONFLICT takes the row lock, so
  // concurrent first attempts serialize; the CASE increments inside the
  // current window and rolls hits/reset_at over only once the stored window
  // has expired. No separate SELECT FOR UPDATE, no lost concurrent hits.
  const result = await getPool().query(
    `INSERT INTO gymos.auth_rate_limits(key_hash,hits,reset_at)
     VALUES($1,1,$2::timestamptz)
     ON CONFLICT(key_hash) DO UPDATE SET
       hits = CASE WHEN gymos.auth_rate_limits.reset_at <= $3::timestamptz THEN 1 ELSE gymos.auth_rate_limits.hits + 1 END,
       reset_at = CASE WHEN gymos.auth_rate_limits.reset_at <= $3::timestamptz THEN excluded.reset_at ELSE gymos.auth_rate_limits.reset_at END
     RETURNING hits, reset_at`,
    [id, new Date(now + windowMs).toISOString(), new Date(now).toISOString()],
  );
  const row = result.rows[0] as { hits: number; reset_at: string };
  const resetAt = Date.parse(row.reset_at);
  if (row.hits > limit) return { allowed: false, retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1000)) };
  return { allowed: true, retryAfter: 0 };
}

// Store parameter is explicit so outage behavior is testable without a live
// backend: any shared-store failure fails CLOSED and retryable (logged) —
// routes answer 503 with Retry-After instead of allowing the request.
export async function consumeWithStore(store: 'firestore' | 'postgres' | null, key: string, limit: number, windowMs: number, now: number): Promise<RateLimitDecision> {
  const shared = store === 'firestore' ? consumeShared : store === 'postgres' ? consumePostgres : null;
  if (shared) {
    try {
      return await shared(key, limit, windowMs, now);
    } catch (error) {
      console.error('[gymeg-rate-limit] shared store unavailable, failing closed', error instanceof Error ? error.message : error);
      return { allowed: false, retryAfter: 30, outage: true };
    }
  }
  return consumeLocal(key, limit, windowMs, now);
}

async function consume(key: string, limit: number, windowMs: number, now: number): Promise<RateLimitDecision> {
  const store = rateLimitStoreFor();
  return consumeWithStore(store === 'local' ? null : store, key, limit, windowMs, now);
}

export async function consumeAuthRateLimit(scope: string, request: Request, email: string, limit: number, windowMs = WINDOW_MS, now = Date.now()): Promise<RateLimitDecision> {
  const ip = requestClientIp(request);
  const perEmail = consume(`${scope}|${ip}|${email.trim().toLowerCase()}`, limit, windowMs, now);
  const perIp = consume(`${scope}|ip:${ip}`, IP_LIMIT, WINDOW_MS, now);
  const [emailDecision, ipDecision] = await Promise.all([perEmail, perIp]);
  if (!emailDecision.allowed || !ipDecision.allowed) {
    // Preserve outage metadata through aggregation: routes answer 503 for a
    // store outage, 429 only for a genuine over-limit decision.
    return {
      allowed: false,
      retryAfter: Math.max(emailDecision.retryAfter, ipDecision.retryAfter),
      ...(emailDecision.outage || ipDecision.outage ? { outage: true } : {}),
    };
  }
  return { allowed: true, retryAfter: 0 };
}

// Intended for tests and deliberate process-level resets; never exposed over HTTP.
// Only the local in-memory buckets are cleared; shared-store windows expire on
// their own within WINDOW_MS.
export function resetAuthRateLimits() { buckets.clear(); }
