# تطبيقات GymEG للموبايل / GymEG mobile applications

## Android downloads

- إدارة النادي — **1.1.9**: [تحميل APK](https://gymeg.vercel.app/downloads/GymEG-Manager-Android-1.1.9.apk)
- الأعضاء — **1.1.8**: [تحميل APK](https://gymeg.vercel.app/downloads/GymEG-Members-Android-1.1.8.apk)
- الدعم الفني — **1.0.7**: [تحميل APK](https://gymeg.vercel.app/downloads/GymEG-Support-Android-1.0.7.apk)
- موقع GymEG: [gymeg.vercel.app](https://gymeg.vercel.app/)

نزّل التطبيق المطلوب وافتح الملف، واسمح بالتثبيت من المتصفح إذا طلب Android ذلك. لا توقف حماية الهاتف ولا تتجاوز تحذيرات النظام. التطبيقات الثلاثة أغلفة Android منفصلة، لكنها تعرض الواجهة الحية من موقع GymEG؛ تحتاج الإنترنت ولا تحتفظ بنسخة كاملة للعمل دون اتصال. لذلك تصل تحديثات الواجهة، ومنها تصميم الكارنيه، من الموقع عند فتح التطبيق.

يلزم Android 8 أو أحدث وAndroid System WebView محدّث. الإدارة تستخدم حساب النادي الحالي وصلاحياته، والعضو يسجل برقم هاتفه. يفتح تطبيق الدعم واجهة الدعم المخصصة. بيانات الإصدار ورابط كل ملف وبصمة SHA-256 موجودة في ملفات JSON بجوار ملفات APK داخل `public/downloads/`.

## Android downloads (English)

- Club management — **1.1.9**: [Download APK](https://gymeg.vercel.app/downloads/GymEG-Manager-Android-1.1.9.apk)
- Members — **1.1.8**: [Download APK](https://gymeg.vercel.app/downloads/GymEG-Members-Android-1.1.8.apk)
- Technical support — **1.0.7**: [Download APK](https://gymeg.vercel.app/downloads/GymEG-Support-Android-1.0.7.apk)
- GymEG website: [gymeg.vercel.app](https://gymeg.vercel.app/)

Download and open the required APK. Allow installation from that browser only if Android asks. Do not disable device security or bypass system warnings. The three Android apps are separate shells that load their live interfaces from the GymEG website. They require internet and do not provide a complete offline copy. Interface updates, including the member-card design, are served from the website when the app opens.

Android 8+ and a current Android System WebView are required. Management uses the club account and its existing permissions; members sign in with their phone number; the support app opens the dedicated support interface. Version, URL and SHA-256 metadata are stored next to each APK in `public/downloads/`.

## iPhone

على iPhone، افتح [GymEG](https://gymeg.vercel.app/) في Safari، ثم اختر مشاركة ← إضافة إلى الشاشة الرئيسية. هذه نسخة ويب قابلة للتثبيت وليست ملف IPA أو إصدار App Store.

On iPhone, open [GymEG](https://gymeg.vercel.app/) in Safari, then choose Share → Add to Home Screen. This is an installable web app, not an IPA or App Store release.

## Signing and verification

إصدارات Android الحالية تحتفظ بشهادة التوقيع نفسها للإصدارات السابقة، لذا يمكن تثبيتها كتحديث فوق التطبيق الحالي. بصمات الشهادة والملفات موجودة في `docs/identity/android-signing-certificates.json`. مفتاح التوقيع وكلمة مروره مستبعدان من حزم التسليم العامة. تم بناء نسخ Release الثلاث وفحص توقيعها ومحاذاتها؛ لم يتم اختبار تثبيت هذه الإصدارات الجديدة على هاتف فعلي أو التحقق من وصول Push عليها.

The current Android releases retain the same signing certificate as their predecessors, so they can update the existing apps in place. Certificate and APK fingerprints are recorded in `docs/identity/android-signing-certificates.json`. The private signing key and password are excluded from public delivery bundles. All three release APKs were built and their signatures/alignment verified; physical installation and push delivery were not tested for these new versions.
