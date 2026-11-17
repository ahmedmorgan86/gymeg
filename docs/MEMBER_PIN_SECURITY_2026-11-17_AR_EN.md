# أرقامPIN الأعضاء — إلغاء القيمة المشتركة / Member PINs — removing the shared default

التاريخ: 17 نوفمبر 2026 · الفرع: `fix/production-readiness-2026-11-17` · لم تُنفَّذ ترحيلات على قاعدة إنتاج من هذه البيئة.

## القرار / Decision

لم يعد النظام يوزّع أو يقبل رقم `123456` أو أي قيمة مشتركة معروفة (`000000`, `111111`, `123456`, `654321`) كرقم سري مؤقت أو شخصي. هذا يلغي قرار المالك السابق الموثّق في الوثائق القديمة.

The system no longer issues or accepts `123456` or any other known shared value (`000000`, `111111`, `123456`, `654321`) as a temporary or chosen PIN. This supersedes the owner's earlier documented decision.

## ما تغيّر / What changed

- `app/lib/member-phone.ts`: مولّد أرقام عشوائية `newMemberPin()` يستبعد القيم المشتركة ورقمًا حاليًا عند إعادة التعيين.
- `app/api/member-code/route.ts`: «إعادة تعيين الرقم السري» تُنشئ رقمًا مؤقتًا جديدًا لكل عضو وتُبطل الجلسات، ولا تُعيد قيمة ثابتة.
- `app/api/member-pin/route.ts`: تغيير الرقم يرفض القيم المشتركة، ويتحقق من أن رخصة النادي قابلة للكتابة قبل إنشاء جلسة جديدة (B13).
- واجهة العضو والموظف: الرسائل لم تعد تنص على قيمة مشتركة؛ الرقم المؤقت يظهر للموظف المصرّح له مرة واحدة عبر «عرض بيانات دخول العضو».
- `supabase/migrations/20261117120000_remove_shared_member_pins.sql`:
  - يعيد تعريف `gymos.new_member_pin()` و`gymos.sync_member_codes()` لاستخدام أرقام عشوائية لكل عضو.
  - يرحّل كل حساب ما زال يطابق قيمة مشتركة إلى رقم عشوائي، ويجعل `pin_must_change=true`، ويزيد `version`، ويحذف جلساته.
  - يُطبَّق لكل مالك على حدة عبر `app.gym_owner` احترامًا لعزل المستأجرين.

## خطوات التشغيل / Operational steps

1. خذ نسخة احتياطية موثّقة قبل تطبيق الترحيل.
2. طبّق كل ترحيلات `supabase/migrations/` بترتيب الأسماء، بما فيها `20261117120000_remove_shared_member_pins.sql`.
3. تحقق في قاعدة البيانات من أن الاستعلام التالي يُعيد صفرًا لكل مالك:
   `SELECT count(*) FROM gymos.member_code_access WHERE pin_hash IS NOT NULL AND (gymos.member_pin_matches('123456',pin_hash) OR gymos.member_pin_matches('000000',pin_hash) OR gymos.member_pin_matches('111111',pin_hash) OR gymos.member_pin_matches('654321',pin_hash));`
4. من ملف العضو، استخدم «عرض بيانات دخول العضو» لتسليم الرقم المؤقت الجديد للعضو نفسه عبر قناة موثّقة، ثم اطلب منه تغييره عند أول دخول.
5. لا يوجد إرسال تلقائي للرقم عبر SMS أو WhatsApp أو البريد؛ التسليم يدوي ومقيد بالصلاحية.

## التحقق / Verification

- `tests/member-phone.test.mjs`: المولّد لا يُنتج القيم المشتركة ولا يكرر رقمًا مستبعدًا صراحةً.
- `tests/member-pin-migration.test.mjs`: فحص ثابت لملف الترحيل ومسارات API ضد القيم المشتركة.
- `tests/member-credentials.integration.mjs`: إعادة التعيين تُعيد رقمًا عشوائيًا مختلفًا عن الحالي ولا تُبطل الصلاحيات.
- `tests/member-session.integration.mjs`: تغيير الرقم يرفض كل القيم المشتركة، ويُمنع مع رخصة موقوفة.
- `tests/member-phone-db.test.mjs` (اختياري عند `GYMOS_DB_TESTS=1`): وظيفة SQL نفسها لا تُنتج قيمًا مشتركة، وتجهيز الأعضاء يُنشئ رقمًا قابلًا للتحقق ولا يساوي قيمة مشتركة.

## UNVERIFIED

لم تتوفر قاعدة بيانات إنتاج أو بيانات اعتمادها في بيئة العمل هذه، لذا لم يُثبت محليًا تطبيق الترحيل على البيانات الفعلية ولا عدد الحسابات المُرحَّلة. يجب تنفيذ خطوات التشغيل أعلاه بواسطة المالك قبل منح الحكم النهائي بالجاهزية.
