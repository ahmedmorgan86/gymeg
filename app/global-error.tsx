'use client';

export default function GlobalError({
  reset,
}: {
  error: Error & {digest?: string};
  reset: () => void;
}) {
  return (
    <html lang="ar" dir="rtl">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#12101C',
          color: '#F5F3FF',
          fontFamily: 'Cairo, sans-serif',
          padding: '24px',
        }}
      >
        <div
          style={{
            maxWidth: '460px',
            textAlign: 'center',
            background: '#1B1729',
            padding: '32px',
            borderRadius: '16px',
            border: '1px solid rgba(255, 255, 255, 0.08)',
          }}
        >
          <h2 style={{margin: '0 0 12px', fontSize: '20px'}}>حدث خطأ غير متوقع</h2>
          <p style={{color: '#B2A9C5', fontSize: '14px', margin: '0 0 20px'}}>
            تعذر تحميل النظام. يرجى إعادة المحاولة.
          </p>
          <button
            onClick={() => reset()}
            style={{
              background: '#7C3AED',
              color: '#fff',
              border: 'none',
              padding: '10px 24px',
              borderRadius: '10px',
              fontSize: '14px',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            إعادة المحاولة
          </button>
        </div>
      </body>
    </html>
  );
}
