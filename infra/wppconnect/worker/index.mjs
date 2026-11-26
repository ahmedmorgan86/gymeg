import http from 'node:http';
import { createHmac } from 'node:crypto';

const GYMEG_BASE = (process.env.GYMEG_API_BASE_URL || '').replace(/\/+$/, '');
const WORKER_SECRET = process.env.GYMEG_WPP_WORKER_SECRET || '';
const WPP_URL = (process.env.WPP_SERVER_URL || 'http://wppconnect:21465').replace(/\/+$/, '');
const WPP_SECRET = process.env.WPP_SECRET_KEY || '';
const POLL_MS = Math.max(5000, Number(process.env.WORKER_POLL_INTERVAL_MS || 15000));
const WEBHOOK_PORT = Number(process.env.WEBHOOK_PORT || 3100);
const WEBHOOK_CALLBACK_URL = process.env.WEBHOOK_CALLBACK_URL || `http://gymeg-worker:${WEBHOOK_PORT}/wpp-webhook`;

if (!GYMEG_BASE || !WORKER_SECRET || !WPP_SECRET) {
  console.error('[worker] Missing GYMEG_API_BASE_URL, GYMEG_WPP_WORKER_SECRET, or WPP_SECRET_KEY');
  process.exit(1);
}

const sessionTokens = new Map();

function signRequest(bodyStr) {
  const ts = String(Date.now());
  const sig = createHmac('sha256', WORKER_SECRET).update(`${ts}.${bodyStr}`).digest('hex');
  return { ts, sig };
}

async function gymegFetch(path, method = 'GET', bodyObj = null) {
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : '';
  const { ts, sig } = signRequest(bodyStr);
  const res = await fetch(`${GYMEG_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-GymEG-Worker-Timestamp': ts,
      'X-GymEG-Worker-Signature': sig,
    },
    ...(bodyObj ? { body: bodyStr } : {}),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`GYMEG ${path} HTTP ${res.status}`);
  return res.json();
}

async function getSessionToken(sessionId) {
  if (sessionTokens.has(sessionId)) return sessionTokens.get(sessionId);
  const res = await fetch(`${WPP_URL}/api/${encodeURIComponent(sessionId)}/${encodeURIComponent(WPP_SECRET)}/generate-token`, {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`WPP generate-token HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.token) throw new Error('WPP token missing');
  sessionTokens.set(sessionId, data.token);
  return data.token;
}

async function wppCall(sessionId, path, method = 'GET', body = undefined) {
  const token = await getSessionToken(sessionId);
  const res = await fetch(`${WPP_URL}/api/${encodeURIComponent(sessionId)}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 401) {
    sessionTokens.delete(sessionId);
  }
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, data: JSON.parse(text) };
  } catch {
    return { ok: res.ok, status: res.status, data: { raw: text } };
  }
}

function mapWppStatus(raw) {
  const s = String(raw || '').toUpperCase();
  if (s === 'CONNECTED' || s === 'ISLOGGED' || s === 'INCHAT') return 'CONNECTED';
  if (s === 'QRCODE' || s === 'WAITING_FOR_QR') return 'WAITING_FOR_QR';
  if (s === 'INITIALIZING' || s === 'STARTING') return 'STARTING';
  if (s === 'PAIRING' || s === 'CONNECTING') return 'CONNECTING';
  if (s === 'RECONNECTING') return 'RECONNECTING';
  if (s === 'CLOSED' || s === 'DISCONNECTED' || s === 'UNPAIRED') return 'DISCONNECTED';
  return 'FAILED';
}

async function handleSessionCommand(cmd) {
  const { ownerId, branch, sessionId, action } = cmd;
  try {
    if (action === 'disconnect') {
      await wppCall(sessionId, '/logout-session', 'POST', {});
      await wppCall(sessionId, '/close-session', 'POST', {});
      await gymegFetch('/api/whatsapp/worker/report', 'POST', {
        kind: 'session',
        ownerId,
        branch,
        sessionId,
        status: 'DISCONNECTED',
      });
      return;
    }

    if (action === 'connect' || action === 'status' || action === 'none') {
      let startData = null;
      if (action === 'connect') {
        const start = await wppCall(sessionId, '/start-session', 'POST', {
          webhook: WEBHOOK_CALLBACK_URL,
          waitQrCode: true,
        });
        startData = start.data;
      }
      const st = await wppCall(sessionId, '/status-session', 'GET');
      let mapped = mapWppStatus(st.data?.status || startData?.status);
      let qrDataUrl = st.data?.qrcode || startData?.qrcode || null;
      let phone = null;

      if (mapped === 'WAITING_FOR_QR' || qrDataUrl) {
        mapped = 'WAITING_FOR_QR';
        if (!qrDataUrl) {
          const qrRes = await wppCall(sessionId, '/qrcode-session', 'GET');
          qrDataUrl = qrRes.data?.qrcode || null;
        }
      } else if (mapped === 'CONNECTED') {
        const host = await wppCall(sessionId, '/host-device', 'GET');
        phone = host.data?.response?.id?.user || host.data?.response?.wid?.user || null;
      }

      await gymegFetch('/api/whatsapp/worker/report', 'POST', {
        kind: 'session',
        ownerId,
        branch,
        sessionId,
        status: mapped,
        qrDataUrl,
        connectedPhone: phone,
      });
    }
  } catch (err) {
    await gymegFetch('/api/whatsapp/worker/report', 'POST', {
      kind: 'session',
      ownerId,
      branch,
      sessionId,
      status: 'FAILED',
      error: err instanceof Error ? err.message.slice(0, 120) : 'worker_error',
    }).catch(() => {});
  }
}

async function handleOutboxJob(job) {
  try {
    const res = await wppCall(job.sessionId, '/send-message', 'POST', {
      phone: job.to,
      message: job.text,
      isGroup: false,
    });
    const providerMessageId = res.data?.response?.[0]?.id || res.data?.id || null;
    await gymegFetch('/api/whatsapp/worker/report', 'POST', {
      kind: 'outbox',
      ownerId: job.ownerId,
      jobId: job.id,
      status: res.ok ? 'sent' : 'failed',
      providerMessageId,
      errorCode: res.ok ? null : `wpp_${res.status}`,
    });
  } catch {
    // Ambiguous network error: mark unknown so we never double-send automatically
    await gymegFetch('/api/whatsapp/worker/report', 'POST', {
      kind: 'outbox',
      ownerId: job.ownerId,
      jobId: job.id,
      status: 'unknown',
      errorCode: 'delivery_unconfirmed_do_not_retry',
    }).catch(() => {});
  }
}

let polling = false;
async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    const work = await gymegFetch('/api/whatsapp/worker/pull', 'GET');
    for (const cmd of work.sessionCommands || []) {
      await handleSessionCommand(cmd);
    }
    for (const job of work.outboxJobs || []) {
      await handleOutboxJob(job);
    }
  } catch (err) {
    console.error('[worker] poll error:', err instanceof Error ? err.message : err);
  } finally {
    polling = false;
  }
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method === 'POST' && req.url === '/wpp-webhook') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    try {
      const payload = JSON.parse(raw);
      await gymegFetch('/api/whatsapp/wpp-webhook', 'POST', payload);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false }));
    }
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(WEBHOOK_PORT, '0.0.0.0', () => {
  console.log(`[worker] listening on :${WEBHOOK_PORT}, polling every ${POLL_MS}ms`);
  void pollOnce();
  setInterval(() => void pollOnce(), POLL_MS);
});
