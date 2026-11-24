import { serverAuth } from '../../lib/auth';
import { loginCredentials } from '../../lib/login-errors';
import { sameOrigin } from '../../lib/server-workspace';
import { consumeAuthRateLimit } from '../../lib/auth-rate-limit';

export const dynamic = 'force-dynamic';
const reply = (body: unknown, status: number) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });

export async function POST(request: Request) {
  if (!sameOrigin(request)) return reply({ error: 'origin' }, 403);
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return reply({ error: 'invalid' }, 415);
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > 4096) return reply({ error: 'invalid' }, 413);
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return reply({ error: 'invalid' }, 400); }
    const credentials = loginCredentials(parsed);
    const name = (parsed as { name?: unknown } | null)?.name;
    if (!credentials || credentials.password.length < 12 || typeof name !== 'string' || !name.trim() || name.length > 100) return reply({ error: 'invalid' }, 400);
    const limit = await consumeAuthRateLimit('session:register', request, credentials.email, 5);
    if (limit.outage) { const response = reply({ error: 'connection' }, 503); response.headers.set('Retry-After', String(limit.retryAfter)); return response; }
    if (!limit.allowed) { const response = reply({ error: 'rate_limit' }, 429); response.headers.set('Retry-After', String(limit.retryAfter)); return response; }
    const auth = await serverAuth();
    const result = await auth.auth.signUp({ ...credentials, name: name.trim(), redirectTo: new URL('/auth/callback', request.url).href });
    if (result.error) return reply({ error: result.error.status === 503 ? 'connection' : 'auth_failed' }, result.error.status === 503 ? 503 : 400);
    return reply({ ok: true }, 200);
  } catch { return reply({ error: 'connection' }, 503); }
}
