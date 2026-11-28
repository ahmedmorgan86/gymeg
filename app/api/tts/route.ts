import { z } from 'zod';
import { NextResponse } from 'next/server';
import { context, reply } from '../../lib/server-workspace';
import { assertRequestTenant } from '../../lib/request-tenant';
import { CommercialError } from '../../lib/licensing';
import { consumeWithStore, rateLimitStoreFor } from '../../lib/auth-rate-limit';
import { VOX_VOICES } from '../../lib/vox-voices';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const VOX_STUDIO_BASE = (process.env.VOX_STUDIO_URL || 'https://voxarabicstudio.vercel.app').replace(/\/+$/, '');
const VALID_VOICE_IDS = new Set(VOX_VOICES.map(v => v.id));
const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_TTS_LIMIT = Math.max(1, Number(process.env.VOX_DAILY_LIMIT_PER_CLUB || 30) || 30);
const DAILY_TASHKEEL_LIMIT = Math.max(1, Number(process.env.VOX_DAILY_TASHKEEL_LIMIT_PER_CLUB || 60) || 60);

const ttsSchema = z.object({
  action: z.enum(['tts', 'tashkeel']).default('tts'),
  text: z.string().trim().min(1).max(2000),
  voice: z.string().trim().default('Puck'),
  language: z.enum(['ar', 'en']).default('ar'),
  dialect: z.string().trim().max(80).default('egyptian'),
  style: z.string().trim().max(300).default('Friendly, upbeat, energetic young gym announcer'),
  voiceSettings: z
    .object({
      stability: z.number().min(0).max(100).optional(),
      styleExaggeration: z.number().min(0).max(100).optional(),
      speed: z.number().min(0.5).max(1.6).optional(),
      pitch: z.number().min(-6).max(6).optional(),
      speakerBoost: z.boolean().optional()
    })
    .optional()
});

export async function POST(request: Request) {
  try {
    const ctx = await context();
    if (!ctx) return reply({ error: 'auth' }, 401);
    assertRequestTenant(request, ctx.tenantId, Boolean(ctx.license));
    if (ctx.support) return reply({ error: 'forbidden' }, 403);

    const body = await request.json().catch(() => null);
    const parsed = ttsSchema.safeParse(body);
    if (!parsed.success) {
      return reply({ error: 'invalid' }, 400);
    }

    const input = parsed.data;
    const store = rateLimitStoreFor();
    const limit = input.action === 'tashkeel' ? DAILY_TASHKEEL_LIMIT : DAILY_TTS_LIMIT;
    const quota = await consumeWithStore(
      store === 'local' ? null : store,
      `vox:${ctx.tenantId}:${input.action}`,
      limit,
      DAY_MS,
      Date.now()
    );
    if (!quota.allowed) {
      return NextResponse.json(
        {
          error: quota.outage ? 'unavailable' : 'rateLimit',
          message: quota.outage
            ? 'تعذر التحقق من حصة النادي حاليًا. حاول بعد قليل.'
            : 'وصل هذا النادي إلى الحد اليومي المسموح لتوليد الصوت. حاول مجددًا غدًا.'
        },
        {
          status: quota.outage ? 503 : 429,
          headers: { 'Retry-After': String(Math.max(1, quota.retryAfter)) }
        }
      );
    }

    if (input.action === 'tashkeel') {
      const upstream = await fetch(`${VOX_STUDIO_BASE}/api/tashkeel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: input.text }),
        signal: AbortSignal.timeout(25000)
      });
      const data = await upstream.json().catch(() => ({}));
      if (!upstream.ok || !data?.tashkeelText) {
        return reply({ error: data?.error || 'tts_upstream_error', message: data?.messageAr || data?.message }, upstream.status >= 400 ? upstream.status : 502);
      }
      return reply({ ok: true, text: String(data.tashkeelText) });
    }

    const voice = VALID_VOICE_IDS.has(input.voice) ? input.voice : 'Puck';
    const upstream = await fetch(`${VOX_STUDIO_BASE}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: input.text,
        voice,
        language: input.language,
        dialect: input.dialect,
        style: input.style,
        voiceSettings: input.voiceSettings
      }),
      signal: AbortSignal.timeout(45000)
    });

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok || !data?.audioBase64) {
      return reply(
        { error: data?.errorCode || 'tts_upstream_error', message: data?.messageAr || data?.message || 'Failed to generate audio' },
        upstream.status >= 400 ? upstream.status : 502
      );
    }

    return reply({
      ok: true,
      audioBase64: data.audioBase64,
      mimeType: data.mimeType || 'audio/wav',
      voice
    });
  } catch (e) {
    if (e instanceof CommercialError) return reply({ error: e.code }, e.status);
    return reply({ error: 'unavailable' }, 503);
  }
}
