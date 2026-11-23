'use client';

import {useEffect} from 'react';
import Link from 'next/link';
import {RotateCcw, Home} from 'lucide-react';

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & {digest?: string};
  reset: () => void;
}) {
  useEffect(() => {
    // Log the error digest to the console for diagnosis
    console.error('GymEG runtime error boundary caught:', error);
  }, [error]);

  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '24px',
        background: 'var(--pt-background, #12101C)',
        color: 'var(--pt-text, #F5F3FF)',
        fontFamily: 'Cairo, Inter, sans-serif',
        direction: 'rtl',
      }}
    >
      <div
        style={{
          maxWidth: '480px',
          width: '100%',
          background: 'var(--pt-panel, #1B1729)',
          border: '1px solid var(--line, #ffffff14)',
          borderRadius: '16px',
          padding: '32px 24px',
          textAlign: 'center',
          boxShadow: '0 12px 40px rgba(0, 0, 0, 0.35)',
        }}
      >
        <div
          style={{
            width: '54px',
            height: '54px',
            margin: '0 auto 18px',
            borderRadius: '14px',
            background: 'rgba(239, 68, 68, 0.15)',
            color: '#EF4444',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '26px',
          }}
        >
          !
        </div>

        <h1
          style={{
            fontSize: '20px',
            fontWeight: 800,
            margin: '0 0 10px',
            color: 'var(--pt-text, #F5F3FF)',
          }}
        >
          حدث خطأ غير متوقع في التحميل
        </h1>
        <p
          style={{
            fontSize: '14px',
            color: 'var(--pt-muted, #B2A9C5)',
            lineHeight: 1.6,
            margin: '0 0 24px',
          }}
        >
          تعذر إكمال معالجة الصفحة في الخادم. يمكنك إعادة المحاولة الآن أو الانتقال إلى إدارة الأندية.
        </p>

        {error?.digest && (
          <div
            style={{
              fontSize: '11px',
              fontFamily: 'monospace',
              color: 'var(--pt-muted, #B2A9C5)',
              background: 'rgba(255, 255, 255, 0.04)',
              padding: '6px 10px',
              borderRadius: '8px',
              marginBottom: '20px',
              wordBreak: 'break-all',
              direction: 'ltr',
            }}
          >
            Ref: {error.digest}
          </div>
        )}

        <div
          style={{
            display: 'flex',
            gap: '12px',
            justifyContent: 'center',
            flexWrap: 'wrap',
          }}
        >
          <button
            onClick={() => reset()}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              background: 'linear-gradient(105deg, #7C3AED, #A855F7)',
              color: '#fff',
              border: 'none',
              padding: '11px 20px',
              borderRadius: '11px',
              fontWeight: 700,
              fontSize: '14px',
              cursor: 'pointer',
            }}
          >
            <RotateCcw size={16} />
            إعادة المحاولة
          </button>

          <Link
            href="/clubs"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '8px',
              background: 'var(--pt-panel-raised, #241E35)',
              color: 'var(--pt-text, #F5F3FF)',
              border: '1px solid var(--line, #ffffff14)',
              padding: '11px 20px',
              borderRadius: '11px',
              fontWeight: 700,
              fontSize: '14px',
              textDecoration: 'none',
            }}
          >
            <Home size={16} />
            إدارة الأندية
          </Link>
        </div>
      </div>
    </main>
  );
}
