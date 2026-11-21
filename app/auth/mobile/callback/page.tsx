export const dynamic = 'force-dynamic';

// Landing page for the Android OAuth handoff link when Android has not (yet)
// verified the App Link and the URL opens in the browser instead of the app.
// The handoff code in the query string is single-use and bound to the app's
// verifier, so it is useless to anyone but that app instance; this page never
// reads or displays it.
export default function MobileCallbackPage() {
  return (
    <main dir="rtl" lang="ar" style={{ fontFamily: 'sans-serif', padding: '2rem', textAlign: 'center' }}>
      <h1>تم تسجيل الدخول</h1>
      <p>ارجع إلى تطبيق GymEG لإكمال تسجيل الدخول.</p>
      <p dir="ltr" lang="en">Sign-in complete. Please return to the GymEG app to finish signing in.</p>
    </main>
  );
}
