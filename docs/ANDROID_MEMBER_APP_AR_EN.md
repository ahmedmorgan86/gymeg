# تطبيق الأعضاء Android / Android members app

## التحميل والاستخدام

حمّل [GymEG — الأعضاء Android 1.1.8](https://gymeg.vercel.app/downloads/GymEG-Members-Android-1.1.8.apk) من موقع [GymEG](https://gymeg.vercel.app/)، وافتح الملف واسمح بتثبيته من المتصفح إذا طلب Android ذلك. لا توقف Play Protect ولا تتجاوز تحذيرًا أمنيًا.

يلزم Android 8 أو أحدث وAndroid System WebView محدّث واتصال بالإنترنت. التطبيق غلاف Android يفتح بوابة العضو الحية على `https://gymeg.vercel.app/member`؛ واجهة التطبيق والكارت تتحدث من الموقع، لكن التطبيق ليس قاعدة محلية كاملة ولا يعمل دون إنترنت.

يسجل العضو برقم الهاتف المسجل لدى النادي. في أول دخول يستخدم الرقم السري الافتراضي 123456 ثم يختار رقمًا شخصيًا من 6 أرقام. يستطيع المالك أو المدير إعادة تعيينه إلى الرقم الافتراضي بناء على طلب العضو، وبعدها يختار العضو رقمًا جديدًا. لا يمكن للإدارة قراءة الرقم الشخصي الحالي. لا يرسل التطبيق رسالة بريد أو SMS للتفعيل.

يعرض ملف العضو بيانات النادي وصورته وقياساته المتاحة وQR والباركود لتسجيل الحضور. إظهار الكارت لا يسجل الحضور وحده؛ يلزم مسح الرمز عند نقطة الدخول. تُطبّق صلاحيات النادي والفرع على بيانات العضو.

## Download and use

Download [GymEG Members for Android 1.1.8](https://gymeg.vercel.app/downloads/GymEG-Members-Android-1.1.8.apk) from the [GymEG website](https://gymeg.vercel.app/). Open the APK and allow installation from that browser if requested by Android. Do not disable Play Protect or bypass a security warning.

Android 8+, a current Android System WebView and internet access are required. The Android app is a shell for the live member portal at `https://gymeg.vercel.app/member`. Its interface and membership pass are served by the website; it is not a full local database and does not work offline.

Members sign in with the phone number registered by their club. On first sign-in, use the default PIN `123456`, then choose a personal six-digit PIN. An owner or manager can reset it to the default at the member's request; the member must then choose a new PIN. Staff cannot read the current personal PIN. Account activation does not send email or SMS.

The member profile shows club data, available photos and measurements, and the QR/barcode used for attendance. Opening the pass alone does not check in the member; the code must be scanned at the entrance. Club and branch permissions scope the displayed data.

## الإصدار والتوقيع / Version and signing

الإصدار الحالي 1.1.8 (versionCode 10). يحتفظ بشهادة التوقيع نفسها للإصدار السابق 1.1.7، لذلك يمكن تثبيته كتحديث فوقه. بصمة الملف والشهادة في `public/downloads/gymeg-members-android.json` و`docs/identity/android-signing-certificates.json`. مفتاح التوقيع وكلمة مروره لا يوجدان في حزمة المصدر العامة.

Current release: 1.1.8 (versionCode 10). It retains the signing certificate from 1.1.7 and can update that version in place. APK and certificate fingerprints are in `public/downloads/gymeg-members-android.json` and `docs/identity/android-signing-certificates.json`. The private signing key and password are not included in the public source bundle.

تم بناء APK وفحص توقيعه ومحاذاته؛ لم يتم تثبيت هذا الإصدار على هاتف فعلي في هذه الدفعة. اختبر تسجيل الدخول والكارت والـQR واستئناف التطبيق على جهاز النادي قبل الاعتماد التشغيلي.

The APK was built and its signature and alignment were verified. This version was not installed on a physical phone in this delivery. Verify sign-in, the pass/QR, and app resume on the club's device before operational use.
