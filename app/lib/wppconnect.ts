import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const WPP_SESSION_STATES = [
  'DISCONNECTED',
  'STARTING',
  'WAITING_FOR_QR',
  'QR_EXPIRED',
  'CONNECTING',
  'CONNECTED',
  'RECONNECTING',
  'FAILED',
] as const;

export type WppSessionStatus = (typeof WPP_SESSION_STATES)[number];
export type WhatsAppProviderKind = 'meta' | 'wppconnect' | 'manual';

export const autoReplyRuleSchema = z.object({
  id: z.string().min(1).max(80).optional(),
  enabled: z.boolean(),
  name: z.string().trim().min(1).max(100),
  keywords: z.array(z.string().trim().min(1).max(80)).max(30),
  replyText: z.string().trim().min(1).max(2000),
  welcomeText: z.string().trim().max(2000).default(''),
  offHoursText: z.string().trim().max(2000).default(''),
  activeDays: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([0, 1, 2, 3, 4, 5, 6]),
  startHour: z.number().int().min(0).max(23).default(8),
  endHour: z.number().int().min(0).max(23).default(23),
  handoffToStaff: z.boolean().default(false),
  cooldownMinutes: z.number().int().min(1).max(1440).default(30),
});

export type AutoReplyRule = z.infer<typeof autoReplyRuleSchema>;

function sessionSalt(): string {
  return process.env.GYMEG_WPP_WORKER_SECRET || process.env.SESSION_SECRET || process.env.AUTH_SECRET || 'gymeg-wpp-session-salt';
}

/**
 * Derives a non-predictable, collision-resistant WPPConnect session ID from tenant + branch.
 */
export function deriveWppSessionId(ownerId: string, branchId: string): string {
  const digest = createHmac('sha256', sessionSalt())
    .update(`${ownerId}|${branchId}`)
    .digest('hex')
    .slice(0, 24);
  return `gym_${digest}`;
}

export function signWorkerPayload(timestampMs: string, rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(`${timestampMs}.${rawBody}`).digest('hex');
}

/**
 * Verifies HMAC-SHA256 signature and 5-minute replay window for Always-On Worker requests.
 */
export function verifyWorkerRequest(request: Request, rawBody: string, nowMs = Date.now()): boolean {
  const secret = process.env.GYMEG_WPP_WORKER_SECRET;
  if (!secret) return false;
  const ts = request.headers.get('x-gymeg-worker-timestamp') ?? '';
  const sig = request.headers.get('x-gymeg-worker-signature') ?? '';
  if (!/^\d{10,16}$/.test(ts) || !/^[a-f0-9]{64}$/i.test(sig)) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(nowMs - tsNum) > 5 * 60 * 1000) return false;

  const expected = signWorkerPayload(ts, rawBody, secret);
  const a = Buffer.from(sig.toLowerCase(), 'utf8');
  const b = Buffer.from(expected.toLowerCase(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export type TemplateVars = {
  name?: string;
  gym?: string;
  branch?: string;
  expires?: string;
  balance?: string;
  date?: string;
  occasion?: string;
};

/**
 * Renders WhatsApp text templates supporting all GYMEG placeholders cleanly.
 */
export function renderWhatsAppText(template: string, vars: TemplateVars): string {
  return template
    .replaceAll('{name}', vars.name ?? '')
    .replaceAll('{gym}', vars.gym ?? '')
    .replaceAll('{branch}', vars.branch ?? '')
    .replaceAll('{expires}', vars.expires ?? '')
    .replaceAll('{balance}', vars.balance ?? '')
    .replaceAll('{date}', vars.date ?? '')
    .replaceAll('{occasion}', vars.occasion ?? '');
}

/**
 * Deterministic rule-based auto-reply evaluator (no paid AI required) with cooldown & working-hours guard.
 */
export function evaluateAutoReply(params: {
  rules: Array<{
    id: string;
    enabled: boolean;
    keywords: string[];
    reply_text: string;
    welcome_text?: string;
    off_hours_text?: string;
    active_days?: number[];
    start_hour?: number;
    end_hour?: number;
    handoff_to_staff?: boolean;
    cooldown_minutes?: number;
  }>;
  inboundText: string;
  isFirstMessage: boolean;
  lastAutoReplyAt: string | null;
  nowIso: string;
  timeZone: string;
  vars: TemplateVars;
}): { matchedRuleId: string; replyText: string; handoff: boolean } | null {
  const { rules, inboundText, isFirstMessage, lastAutoReplyAt, nowIso, timeZone, vars } = params;
  const text = inboundText.trim().toLowerCase();
  if (!text) return null;

  const nowMs = Date.parse(nowIso);
  const dt = new Date(nowMs);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'Africa/Cairo',
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(dt);
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const day = wdMap[parts.find((p) => p.type === 'weekday')?.value ?? 'Sun'] ?? 0;
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 12);

  for (const r of rules) {
    if (!r.enabled) continue;
    const cooldownMs = Math.max(1, r.cooldown_minutes ?? 30) * 60 * 1000;
    if (lastAutoReplyAt && nowMs - Date.parse(lastAutoReplyAt) < cooldownMs) {
      continue;
    }

    const activeDays = Array.isArray(r.active_days) && r.active_days.length ? r.active_days : [0, 1, 2, 3, 4, 5, 6];
    const startH = r.start_hour ?? 0;
    const endH = r.end_hour ?? 23;
    const inHours = activeDays.includes(day) && (startH <= endH ? hour >= startH && hour <= endH : hour >= startH || hour <= endH);

    if (!inHours) {
      if (r.off_hours_text) {
        return {
          matchedRuleId: r.id,
          replyText: renderWhatsAppText(r.off_hours_text, vars),
          handoff: Boolean(r.handoff_to_staff),
        };
      }
      continue;
    }

    const matchedKeyword = (r.keywords ?? []).some((kw) => kw.trim() && text.includes(kw.trim().toLowerCase()));
    if (matchedKeyword) {
      return {
        matchedRuleId: r.id,
        replyText: renderWhatsAppText(r.reply_text, vars),
        handoff: Boolean(r.handoff_to_staff),
      };
    }

    if (isFirstMessage && r.welcome_text) {
      return {
        matchedRuleId: r.id,
        replyText: renderWhatsAppText(r.welcome_text, vars),
        handoff: Boolean(r.handoff_to_staff),
      };
    }
  }
  return null;
}

/**
 * SSRF guard for any external webhook URL.
 */
export function isSafeWebhookUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local')) return false;
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(h)) return false;
    return true;
  } catch {
    return false;
  }
}
