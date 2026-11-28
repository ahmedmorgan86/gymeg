'use client';

import { useState } from 'react';
import { Mic, Sparkles, Sliders } from 'lucide-react';
import {
  VOX_ARABIC_DIALECTS,
  VOX_ENGLISH_DIALECTS,
  VOX_STYLES,
  VOX_VOICES
} from './lib/vox-voices';

interface VoxStudioPanelProps {
  owner: string;
  ar: boolean;
  onAudioGenerated: (file: File) => Promise<void> | void;
}

export default function VoxStudioPanel({ owner, ar, onAudioGenerated }: VoxStudioPanelProps) {
  const t = (a: string, e: string) => (ar ? a : e);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [language, setLanguage] = useState<'ar' | 'en'>('ar');
  const [dialect, setDialect] = useState('egyptian');
  const [voice, setVoice] = useState('Puck');
  const [style, setStyle] = useState<string>(VOX_STYLES[0].id);
  const [speed, setSpeed] = useState(1.0);
  const [stability, setStability] = useState(55);
  const [styleExaggeration, setStyleExaggeration] = useState(35);
  const [pitch, setPitch] = useState(0);
  const [speakerBoost, setSpeakerBoost] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tashkeelBusy, setTashkeelBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const dialects = language === 'ar' ? VOX_ARABIC_DIALECTS : VOX_ENGLISH_DIALECTS;

  async function handleTashkeel() {
    if (!text.trim() || tashkeelBusy || busy) return;
    setTashkeelBusy(true);
    setError('');
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-GymOS-Tenant': owner },
        body: JSON.stringify({ action: 'tashkeel', text: text.trim() })
      });
      const data = await res.json();
      if (!res.ok || !data.text) {
        setError(data.message || t('تعذر تشكيل النص الآن.', 'Could not diacritize text right now.'));
        return;
      }
      setText(data.text);
    } catch {
      setError(t('تعذر الاتصال بخدمة التشكيل.', 'Failed to reach diacritization service.'));
    } finally {
      setTashkeelBusy(false);
    }
  }

  async function handleGenerate() {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-GymOS-Tenant': owner },
        body: JSON.stringify({
          action: 'tts',
          text: text.trim(),
          voice,
          language,
          dialect,
          style,
          voiceSettings: {
            speed,
            stability,
            styleExaggeration,
            pitch,
            speakerBoost
          }
        })
      });
      const data = await res.json();
      if (!res.ok || !data.audioBase64) {
        setError(data.message || t('تعذر توليد الصوت الآن. حاول مرة أخرى.', 'Failed to generate voice audio.'));
        return;
      }

      const binary = atob(data.audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: data.mimeType || 'audio/wav' });
      const file = new File([blob], `vox-${voice.toLowerCase()}-${Date.now()}.wav`, {
        type: data.mimeType || 'audio/wav'
      });
      await onAudioGenerated(file);
      setSuccess(t(`تم توليد وتثبيت الصوت (${voice}) بنجاح ✅`, `Generated and attached voice (${voice}) ✅`));
    } catch {
      setError(t('حدث خطأ أثناء توليد الصوت.', 'An error occurred while generating audio.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: '0.75rem', border: '1px solid rgba(139, 92, 246, 0.35)', borderRadius: 10, padding: '0.75rem 1rem', background: 'rgba(139, 92, 246, 0.06)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 700, fontSize: '0.92rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <Sparkles size={16} /> {t('استوديو توليد الصوت بالذكاء الاصطناعي (VoxArabic)', 'AI Voice Generator (VoxArabic Studio)')}
        </span>
        <button type="button" className="button secondary" onClick={() => setOpen(v => !v)} style={{ padding: '0.35rem 0.75rem', fontSize: '0.82rem' }}>
          {open ? t('إخفاء الاستوديو', 'Hide studio') : t('🎙️ توليد صوت من نص', '🎙️ Generate from text')}
        </button>
      </div>

      {open && (
        <div style={{ marginTop: '0.85rem', display: 'grid', gap: '0.75rem' }}>
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.3rem' }}>
              <label style={{ fontWeight: 600, fontSize: '0.85rem' }}>{t('نص النداء الصوتي', 'Announcement script')}</label>
              {language === 'ar' && (
                <button type="button" className="text-button" disabled={tashkeelBusy || busy || !text.trim()} onClick={() => void handleTashkeel()} style={{ fontSize: '0.8rem' }}>
                  {tashkeelBusy ? t('جاري التشكيل…', 'Diacritizing…') : t('✨ تشكيل تلقائي', '✨ Auto diacritics')}
                </button>
              )}
            </div>
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              maxLength={1500}
              rows={3}
              placeholder={t('اكتب النص باللهجة المصرية أو الفصحى، مثال: يا أبطال بنفكركم ميعاد الحصة بدأ...', 'Write the announcement script...')}
              style={{ width: '100%', boxSizing: 'border-box', padding: '0.6rem', borderRadius: 6 }}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '0.65rem' }}>
            <label style={{ fontSize: '0.82rem' }}>
              {t('اللغة', 'Language')}
              <select
                value={language}
                onChange={e => {
                  const next = e.target.value === 'en' ? 'en' : 'ar';
                  setLanguage(next);
                  setDialect(next === 'ar' ? 'egyptian' : 'american');
                }}
                style={{ width: '100%', padding: '0.45rem', marginTop: '0.2rem' }}
              >
                <option value="ar">{t('العربية', 'Arabic')}</option>
                <option value="en">{t('الإنجليزية', 'English')}</option>
              </select>
            </label>

            <label style={{ fontSize: '0.82rem' }}>
              {t('اللهجة', 'Dialect')}
              <select value={dialect} onChange={e => setDialect(e.target.value)} style={{ width: '100%', padding: '0.45rem', marginTop: '0.2rem' }}>
                {dialects.map(d => (
                  <option key={d.id} value={d.id}>{ar ? d.ar : d.en}</option>
                ))}
              </select>
            </label>

            <label style={{ fontSize: '0.82rem' }}>
              {t('الصوت', 'Voice')}
              <select value={voice} onChange={e => setVoice(e.target.value)} style={{ width: '100%', padding: '0.45rem', marginTop: '0.2rem' }}>
                {VOX_VOICES.map(v => (
                  <option key={v.id} value={v.id}>
                    {ar ? `${v.nameAr} · ${v.timbreAr}` : `${v.nameEn} · ${v.timbreEn}`}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ fontSize: '0.82rem' }}>
              {t('أسلوب الإلقاء', 'Delivery style')}
              <select value={style} onChange={e => setStyle(e.target.value)} style={{ width: '100%', padding: '0.45rem', marginTop: '0.2rem' }}>
                {VOX_STYLES.map(s => (
                  <option key={s.id} value={s.id}>{ar ? s.ar : s.en}</option>
                ))}
              </select>
            </label>
          </div>

          <details style={{ border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, padding: '0.5rem 0.75rem' }}>
            <summary style={{ cursor: 'pointer', fontSize: '0.83rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <Sliders size={14} /> {t('أدوات التحكم المتقدمة (السرعة، الثبات، الحدة، التحسين)', 'Advanced voice controls (speed, stability, pitch, boost)')}
            </summary>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '0.65rem', marginTop: '0.7rem' }}>
              <label style={{ fontSize: '0.8rem' }}>
                {t('سرعة الكلام', 'Speed')}: {speed.toFixed(2)}x
                <input type="range" min={0.6} max={1.5} step={0.05} value={speed} onChange={e => setSpeed(Number(e.target.value))} style={{ width: '100%' }} />
              </label>
              <label style={{ fontSize: '0.8rem' }}>
                {t('الثبات', 'Stability')}: {stability}%
                <input type="range" min={0} max={100} step={5} value={stability} onChange={e => setStability(Number(e.target.value))} style={{ width: '100%' }} />
              </label>
              <label style={{ fontSize: '0.8rem' }}>
                {t('التعبير الدرامي', 'Style exaggeration')}: {styleExaggeration}%
                <input type="range" min={0} max={100} step={5} value={styleExaggeration} onChange={e => setStyleExaggeration(Number(e.target.value))} style={{ width: '100%' }} />
              </label>
              <label style={{ fontSize: '0.8rem' }}>
                {t('حدة الصوت (Pitch)', 'Pitch')}: {pitch > 0 ? `+${pitch}` : pitch}
                <input type="range" min={-6} max={6} step={1} value={pitch} onChange={e => setPitch(Number(e.target.value))} style={{ width: '100%' }} />
              </label>
            </div>
            <label className="checkbox" style={{ marginTop: '0.5rem', fontSize: '0.82rem' }}>
              <input type="checkbox" checked={speakerBoost} onChange={e => setSpeakerBoost(e.target.checked)} />
              {t('تحسين نقاء الصوت الاستوديو (Speaker Boost)', 'Studio vocal clarity (Speaker Boost)')}
            </label>
          </details>

          {error && <p style={{ color: '#f87171', fontSize: '0.83rem', margin: 0 }}>{error}</p>}
          {success && <p style={{ color: '#4ade80', fontSize: '0.83rem', margin: 0 }}>{success}</p>}

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button type="button" className="button primary" disabled={busy || !text.trim()} onClick={() => void handleGenerate()}>
              <Mic size={16} /> {busy ? t('جاري توليد الصوت…', 'Generating audio…') : t('🎙️ توليد الصوت وتعيينه للنداء', '🎙️ Generate & attach audio')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
