# إعداد Firebase لـ GymEG — دليل خطوة بخطوة

هذا الدليل يغطي كل خطوات ربط التطبيق بمشروع Firebase: إنشاء المشروع، تفعيل تسجيل الدخول (البريد + Google)، نشر قواعد الأمان والفهارس، متغيرات البيئة، وحساب المدير الأول وبيانات الجيم التجريبية.

> **ملاحظة مهمة:** Firestore لا يحتوي على "جداول" تنشئها يدويًا. المجموعات (Collections) مثل `gym_states` و`gym_entities` تُنشأ تلقائيًا مع أول كتابة من التطبيق. المطلوب منك في لوحة التحكم هو: إنشاء قاعدة البيانات، نشر **القواعد** (Rules) و**الفهارس** (Indexes) — وكلاهما جاهز في هذا المستودع (`firestore.rules` و`firestore.indexes.json`).

---

## ١) إنشاء المشروع وقاعدة البيانات

1. افتح [Firebase Console](https://console.firebase.google.com) ← **Add project** ← اختر اسمًا (مثل `gymeg`) وأكمل الإنشاء (يمكنك إيقاف Google Analytics).
2. من القائمة الجانبية: **Build ← Firestore Database** ← **Create database** ← اختر **Production mode** ← اختر أقرب منطقة (مثل `eur3` لأوروبا) ← **Enable**.
3. من **Project settings** (أيقونة الترس) انسخ **Project ID** — ستحتاجه في كل الخطوات التالية.

## ٢) تفعيل تسجيل الدخول

من **Build ← Authentication ← Sign-in method**:

1. **Email/Password**: فعّل الخيار الأول (Email/Password) واحفظ. التطبيق يستخدم تأكيد البريد تلقائيًا.
2. **Google**: فعّل مزود Google، اختر بريد الدعم، واحفظ. بعد الحفظ افتح إعدادات المزود مرة أخرى وانسخ من قسم **Web SDK configuration**:
   - **Web client ID** ← قيمة `GYMEG_GOOGLE_CLIENT_ID`
   - **Web client secret** ← قيمة `GYMEG_GOOGLE_CLIENT_SECRET`
3. في تبويب **Settings** الخاص بـ Authentication تأكد أن نطاق موقعك (مثل `gymeg.app` و`localhost`) موجود ضمن **Authorized domains** — نطاق `*.firebaseapp.com` و`localhost` مضافان افتراضيًا.
4. زر تسجيل الدخول بـ Google في التطبيق يستخدم المسار `/api/auth/google/callback`. يجب إضافته كرابط إعادة توجيه معتمد:
   - افتح [Google Cloud Console](https://console.cloud.google.com/apis/credentials) لنفس المشروع ← **Credentials** ← اضغط على الـ OAuth 2.0 Client ID الخاص بالويب (نفس الـ Web client ID أعلاه).
   - في **Authorized redirect URIs** أضف: `https://<نطاق-موقعك>/api/auth/google/callback` وللتطوير المحلي `http://localhost:3000/api/auth/google/callback` ← **Save**.

## ٣) مفتاح حساب الخدمة (Service Account)

التطبيق يتصل بـ Firestore من الخادم عبر حساب خدمة (وليس من المتصفح — قواعد الأمان تمنع الوصول المباشر عمدًا):

1. **Project settings ← Service accounts** ← **Generate new private key** ← **Generate**. سيُنزَّل ملف JSON.
2. حوّل محتوى الملف كاملًا إلى سطر واحد (بدون أسطر جديدة) وضعه في متغير `GYMEG_FIREBASE_SERVICE_ACCOUNT`. على لينكس/ماك:
   ```bash
   jq -c . < service-account.json
   ```
3. **لا ترفع هذا الملف إلى Git أبدًا** — يبقى في متغيرات البيئة فقط.

## ٤) مفتاح الويب (Web API Key)

**Project settings ← General ← Web API Key** ← انسخه في `FIREBASE_WEB_API_KEY`. يُستخدم في تسجيل الدخول بالبريد وبـ Google عبر REST.

## ٥) نشر قواعد الأمان والفهارس

القواعد والفهارس جاهزة في المستودع؛ تنشرها بأداة Firebase من جهازك:

```bash
npm install -g firebase-tools
firebase login
firebase deploy --only firestore --project <PROJECT_ID>
```

هذا الأمر ينشر `firestore.rules` و`firestore.indexes.json` معًا (المحددان في `firebase.json`). القواعد الحالية تمنع كل وصول المتصفح (`allow read, write: if false`) وهذا **مقصود**: كل القراءة والكتابة تمر عبر خادم التطبيق بعد التحقق من الجلسة والصلاحيات، وحساب الخدمة يتجاوز القواعد بأمان.

بناء الفهارس قد يستغرق دقائق؛ تابع حالته من **Firestore Database ← Indexes**.

## ٦) متغيرات البيئة

أضف هذه القيم في Vercel (**Project ← Settings ← Environment Variables**) أو في `.env.local` محليًا:

| المتغير | المصدر |
|---|---|
| `GYMEG_FIREBASE_SERVICE_ACCOUNT` | ملف حساب الخدمة كاملًا (سطر واحد) — الخطوة ٣ |
| `FIREBASE_WEB_API_KEY` | Web API Key — الخطوة ٤ |
| `GYMEG_GOOGLE_CLIENT_ID` | إعدادات مزود Google — الخطوة ٢ |
| `GYMEG_GOOGLE_CLIENT_SECRET` | إعدادات مزود Google — الخطوة ٢ |
| `GYMEG_FIREBASE_PROJECT_ID` | اختياري — يُستنتج تلقائيًا من ملف حساب الخدمة |
| `GYMEG_MEMBER_PIN_KEY` | مفتاح ٣٢ بايت Base64 لتشفير رموز دخول الأعضاء: `openssl rand -base64 32` |

بعد إضافة المتغيرات في Vercel أعد النشر (Redeploy). تحقق من نجاح الاتصال عبر: `https://<نطاق-موقعك>/api/health` — يجب أن يعيد `{"status":"ready","provider":"firebase"}`.

## ٧) حساب مدير المنصة الأول

بعد تسجيل أول حساب من صفحة التطبيق وتأكيد بريده:

```bash
GYMEG_FIREBASE_SERVICE_ACCOUNT="$(jq -c . < service-account.json)" \
node scripts/firebase-bootstrap-admin.mjs <Firebase-UID>
```

الـ UID تجده في **Authentication ← Users** بجانب المستخدم.

## ٨) بيانات الجيم التجريبية

سكربت `scripts/seed-complete-demo.mjs` يملأ ناديًا تجريبيًا ببيانات وهمية كاملة (أعضاء، حضور، مدفوعات، …) ويعمل الآن على Firestore وعلى Postgres معًا:

1. أنشئ النادي التجريبي من التطبيق نفسه بحساب مالك تجريبي، وسمِّه باسم يحتوي «تجريبي» أو «اختبار» أو `demo` — السكربت **يرفض** أي نادي لا يبدو تجريبيًا حمايةً للبيانات الحقيقية.
2. شغّله من جهازك مع نفس متغيرات البيئة:
   ```bash
   GYMOS_DEMO_STORAGE_KEY=<storage-key-للنادي> \
   GYMOS_DEMO_COUNT=200 \
   node --env-file-if-exists=.env.local scripts/seed-complete-demo.mjs --confirm-test-club
   ```
   قيمة `GYMOS_DEMO_STORAGE_KEY` هي معرّف مساحة النادي (نفس قيمة `user_id` في مستند `gym_states`).
3. يحفظ السكربت نسخة احتياطية قبل البدء وتقرير تحقق بعد الانتهاء داخل مجلد `.demo-artifacts`، ولا يمس أعضاء النادي الموجودين قبله ولا رموز دخولهم.

## استكشاف الأخطاء

| العَرَض | السبب المحتمل |
|---|---|
| `/api/health` يعيد 503 | `GYMEG_FIREBASE_SERVICE_ACCOUNT` غير مضبوط أو ليس سطرًا واحدًا صالحًا |
| "الدخول بحساب Google غير مُفعَّل" | `GYMEG_GOOGLE_CLIENT_ID/SECRET` ناقصان في البيئة |
| فشل دخول Google بعد اختيار الحساب | رابط إعادة التوجيه غير مضاف في Google Cloud (الخطوة ٢.٤) أو مزود Google غير مفعّل |
| `permission-denied` في السجلات | قواعد الأمان غير منشورة — نفّذ الخطوة ٥ (تذكّر: وصول الخادم لا يحتاج قواعد، لكن نشرها إلزامي لأمان المشروع) |
| `FAILED_PRECONDITION: index` | الفهارس لم تُنشر أو ما زالت تُبنى — الخطوة ٥ |
