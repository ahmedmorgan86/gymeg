'use client';
import type { BodyMeasurement } from './lib/domain';

function deltaText(cur: number | null | undefined, prev: number | null | undefined, unit: string) {
  if (typeof cur !== 'number' || typeof prev !== 'number') return null;
  const diff = Math.round((cur - prev) * 10) / 10;
  if (diff === 0) return `0 ${unit}`;
  return `${diff > 0 ? '+' : ''}${diff} ${unit}`;
}

/** Displays latest InBody metrics, deltas vs previous entry, and a weight trend SVG. */
export default function InBodyProgress({ measurements, ar }: { measurements: BodyMeasurement[]; ar: boolean }) {
  const t = (a: string, b: string) => (ar ? a : b);
  const sorted = [...measurements].sort((a, b) => a.day.localeCompare(b.day));
  if (!sorted.length) return null;

  const latest = sorted[sorted.length - 1];
  const prev = sorted.length > 1 ? sorted[sorted.length - 2] : null;
  const weightDelta = deltaText(latest.weight, prev?.weight, 'kg');
  const fatDelta = deltaText(latest.bodyFat, prev?.bodyFat, '%');
  const muscleDelta = deltaText(latest.muscleMass, prev?.muscleMass, 'kg');

  const weights = sorted.slice(-12).map((m) => m.weight);
  const minW = Math.min(...weights);
  const maxW = Math.max(...weights);
  const span = Math.max(1, maxW - minW);
  const pts = weights
    .map((w, i) => {
      const x = weights.length === 1 ? 140 : (i / (weights.length - 1)) * 280;
      const y = 52 - ((w - minW) / span) * 40;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  return (
    <section className="card" style={{ marginBottom: 14, padding: 14 }} aria-label={t('ملخص InBody والتقدم', 'InBody & Progress Summary')}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <b>{t('مؤشرات InBody والتطور', 'InBody & Body Composition')}</b>
        <small style={{ color: 'var(--muted)' }}>{latest.day}</small>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8, marginBottom: sorted.length > 1 ? 12 : 0 }}>
        <div className="profile-history" style={{ margin: 0, padding: 10 }}>
          <small>{t('الوزن', 'Weight')}</small>
          <div style={{ fontWeight: 800, fontSize: 16 }}>{latest.weight} kg</div>
          {weightDelta && <small style={{ color: 'var(--muted)' }}>{weightDelta}</small>}
        </div>
        {typeof latest.bodyFat === 'number' && (
          <div className="profile-history" style={{ margin: 0, padding: 10 }}>
            <small>{t('نسبة الدهون', 'Body fat')}</small>
            <div style={{ fontWeight: 800, fontSize: 16 }}>{latest.bodyFat}%</div>
            {fatDelta && <small style={{ color: 'var(--muted)' }}>{fatDelta}</small>}
          </div>
        )}
        {typeof latest.muscleMass === 'number' && (
          <div className="profile-history" style={{ margin: 0, padding: 10 }}>
            <small>{t('الكتلة العضلية', 'Muscle mass')}</small>
            <div style={{ fontWeight: 800, fontSize: 16 }}>{latest.muscleMass} kg</div>
            {muscleDelta && <small style={{ color: 'var(--muted)' }}>{muscleDelta}</small>}
          </div>
        )}
        {typeof latest.bmi === 'number' && (
          <div className="profile-history" style={{ margin: 0, padding: 10 }}>
            <small>BMI</small>
            <div style={{ fontWeight: 800, fontSize: 16 }}>{latest.bmi}</div>
          </div>
        )}
        {typeof latest.waterPct === 'number' && (
          <div className="profile-history" style={{ margin: 0, padding: 10 }}>
            <small>{t('نسبة الماء', 'Body water')}</small>
            <div style={{ fontWeight: 800, fontSize: 16 }}>{latest.waterPct}%</div>
          </div>
        )}
        {typeof latest.visceralFat === 'number' && (
          <div className="profile-history" style={{ margin: 0, padding: 10 }}>
            <small>{t('الدهون الحشوية', 'Visceral fat')}</small>
            <div style={{ fontWeight: 800, fontSize: 16 }}>{latest.visceralFat}</div>
          </div>
        )}
      </div>
      {sorted.length > 1 && (
        <div>
          <small style={{ color: 'var(--muted)', display: 'block', marginBottom: 4 }}>
            {t('منحنى تطور الوزن (آخر ١٢ قياس)', 'Weight progress curve (last 12)')}
          </small>
          <svg viewBox="0 0 280 60" style={{ width: '100%', height: 60, overflow: 'visible' }} role="img" aria-label={t('منحنى الوزن', 'Weight trend')}>
            <polyline fill="none" stroke="var(--pt-primary, #7c3aed)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" points={pts} />
          </svg>
        </div>
      )}
    </section>
  );
}
