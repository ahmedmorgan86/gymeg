# تقرير فحص Gymeg — 17 نوفمبر 2026 (مرحلة الفحص فقط)

> هذا التقرير موثّق قبل أي تعديل على الكود. كل سطر مذكور مُقتبس من الملف الموجود فعليًا في مجلد العمل.
> التعريفات: P0 = خطر أمني/فقد بيانات/عطل يمنع البيع · P1 = خلل تشغيل أساسي · P2 = تحسين مهم · P3 = تحسين اختياري.
> الحالة في الجداول هي حالة ما قبل الإصلاح (`OPEN`) مع تحديثات الحالة بعد الإصلاح والتحقق. أُضيف سجل التحقق في إنتاج Supabase في القسم 6.

## 1. نطاق الفحص والمنهج

- فُحصت البنية، 29 مسار API، طبقة `app/lib`، ملفات SQL الأساسية و16 ترحيلًا في `supabase/migrations/`، إعدادات Next/Vercel/CI، 80 ملف اختبار وحدة، 19 ملف تكامل، مصادر Android/Windows/iOS، بيانات الإصدارات والتوقيعات، والوثائق التي تدّعي التحقق.
- في البداية لم يُنفَّذ أي اختبار على قاعدة إنتاج أو أجهزة فعلية أو مزوّدي خدمات؛ كل ما لا يمكن إثباته كان موسومًا بـ `UNVERIFIED`. لاحقًا أُضيف تحقق فعلي من إنتاج Supabase كما هو موثّق في القسم 6.
- في نسخة العمل الأولية لم يكن مجلد `.git` متاحًا، لذا استُخدمت نسخة المستودع اللاحقة لتاريخ Git؛ نقطة الرجوع `c14add6` والفرع `fix/production-readiness-2026-11-17`.

### خط الأساس المقاس محليًا (قبل التعديل)

| الأمر | النتيجة |
|---|---|
| `npm ci --no-audit --no-fund` | نجح (612 حزمة، Node v24.19.0) |
| `npm test` | 289 test / 282 pass / 0 fail / 7 skipped |
| `npm run typecheck` | نجح (خارج الصندوق؛ لا يوجد `next-env.d.ts` بعد) |
| `npm run lint` | نجح |
| `npm run release:check` | نجح (Android 1.1.9/1.1.8/1.0.7، Windows 1.1.16) |
| `npm audit --omit=dev --audit-level=low` | **فشل**: ثغرة `next 16.4.2` المتوسطة GHSA-mfr8-8qww-v76h، الإصلاح 16.4.6 |
| `npm run build` | نجح (Next 16.4.2، webpack، output standalone) |

## 2. سجل العيوب

### P0 — يمنع البيع أو يعرض البيانات للخطر

| ID | المشكلة | الملف:السطر | الدليل | التأثير على المستخدم | الحل المقترح | اختبار التحقق | الحالة |
|---|---|---|---|---|---|---|---|
| A01 | التحقق من `Origin` يعتمد على ترويسات `x-forwarded-*` القادمة من العميل | `app/lib/server-workspace.ts:16` | `const hostHeader=(request.headers.get('x-forwarded-host')||request.headers.get('host')||reqUrl.host)...` و `protoHeader=...x-forwarded-proto...` | تزوير الترويسات قد يخدع حماية CSRF على الطلبات التي تستخدم الكوكيز | مقارنة `Origin` بـ `request.url.origin` أو قائمة أصول مسموحة صراحةً من المتغيرات البيئية، وتجاهل الترويسات الواردة | اختبار: `Origin: https://evil.test` مع ترويسات مزوّرة يجب أن يعطي 403 | FIXED — `app/lib/request-origin.ts` + `tests/security-origin.test.mjs` |
| A02 | الرقم السري الافتراضي المشترك `123456` مُثبّت في الكود والترحيل ويُعاد من API | `app/api/member-code/route.ts:15`, `supabase/migrations/20261023221405_member_default_pin_change.sql:12,19` | `const pin='123456'` / `pin:='123456'` / `UPDATE ... pin_hash=gymos.member_pin_hash('123456')` | أي شخص يعرف رقم هاتف العضو يمكنه تسجيل الدخول قبل العضو وتغيير PIN | توليد PIN عشوائي لكل عضو، ترحيل الحسابات التي تستخدم القيمة المشتركة، إبطال جلساتها، ومنع اختيار القيمة المشتركة | اختبار DB + API: لا يوجد pin يساوي `123456`، و`rotate` يُعيد رقمًا عشوائيًا مختلفًا | FIXED — `20261117120000_remove_shared_member_pins.sql`, `newMemberPin()`، اختبارات PIN؛ طُبّق في إنتاج Supabase: `shared_pin_accounts=181` قبل الترحيل و`0` بعده (`pin_fn=true`)؛ انظر القسم 6. قيمة ciphertext قديمة غير مقروءة واحدة على الأقل خارج نطاق PINs المشتركة ما زالت `UNVERIFIED` |
| A03 | قاعدة البيانات تقبل أي شهادة TLS | `app/lib/database.ts:22,27` | `for(const param of ['sslmode','sslrootcert',...])url.searchParams.delete(param)` و `rejectUnauthorized:false` | هجوم MITM على الاتصال يقرأ/يعدّل بيانات كل الأندية والنسخ الاحتياطية | `rejectUnauthorized:true` مع CA موثوق، فشل مغلق في الإنتاج عند غياب الشهادة، وعدم حذف معاملات SSL | اختبار: نقطة TLS بشهادة موقّعة ذاتيًا يجب أن تُرفض | FIXED — `app/lib/database.ts` fail-closed + `tests/database-fail-closed.test.mjs` |
| A04 | استعادة النسخة متاحة لأي مدير يغطي كل الفروع دون منح صريح | `app/api/backup/route.ts:13,19`, `app/lib/access.ts:3` | `if(!(await administrator(ctx)))` ثم `persistSpace(...,true)`؛ و `fullAdministration` تسمح بمدير بكل الفروع | مدير بلا صلاحية استعادة يمكنه استبدال كل بيانات النادي | السماح للمالك، أو للمدير الذي لديه منح صريح `backup.restore` من المالك + كل الفروع | اختبار API: مدير بكل الفروع بلا منح يحصل على 403؛ مع المنح ينجح | FIXED — `backup.restore` مقصور على المالك أو منح صريح؛ `tests/backup-api.integration.mjs` (3 pass) |
| A05 | النسخة الاحتياطية تنقل خريطة منح الاستقبال عكس ما هو موثّق | `app/api/backup/route.ts:19`, `app/lib/backup.ts:21`, `README.md:43` | `settings:z.object({receptionGrants:...})`، والاستعادة تستبدل الحالة كاملة | استعادة نسخة قديمة تُعيد منح موظفين أو تُسحب صلاحيات حالية، وقد تستورد خريطة نادٍ آخر | الإبقاء على `receptionGrants` الحالية أثناء الاستعادة وتحديث التوثيق | اختبار: منح مختلف في الحالة والنسخة → بعد الاستعادة تبقى الحالية | FIXED — الاستعادة تحتفظ بمنح الاستقبال الحالية؛ `tests/backup-api.integration.mjs`, `README.md`, `MIGRATION_AR.md` |
| A06 | استيراد نسخة من tenant غريب بمجرد علمية `importTenant:true` في الوضع غير التجاري | `app/api/backup/route.ts:19` | `backup.tenant!==ctx.owner && (ctx.license!==null||body.importTenant!==true)` | خلط حالة نادٍ آخر في مساحة الحالي؛ كسر سلامة المصدر | رفض أي tenant غير `ctx.owner/ctx.tenantId` عبر API، ونقل الحالة القديمة إلى إجراء إداري موثّق ومنفصل | اختبار API:tenant غريب + `importTenant:true` → 400 | FIXED — `importTenant` أُزيل من API/العميل/الواجهة؛ فحص tenant للمصدر فقط، وترحيل خارج النطاق موثّق في `MIGRATION_AR.md` |
| A07 | فحص تضارب الباركود في الترحيل عالمي بدل أن يكون لكل نادٍ | `supabase/migrations/20261026224250_unified_member_console.sql:4` | `GROUP BY payload->>'card'` بدون `owner_id` | ناديان يستخدمان نفس رقم الكارت يمنعان الترحيل؛ فشل نشر | تجميع حسب `(owner_id,card)`، وإضافة فحص صريح للجلسات المفتوحة المكررة قبل الفهرس الفريد | اختبار PGlite: ناديان بنفس الكارت يمرّان؛ تكرار جلسة مفتوحة يُرفض برسالة واضحة | FIXED — فحص لكل نادٍ + مفتاح `(owner_id,code)` + ترحيل `20261117135000_owner_scoped_membership_cards.sql`؛ `tests/barcode-owner-scope.test.mjs` (2 pass) |
| A08 | ثغرة معلنة في `next@16.4.2` تُفشل بوابة الجودة | `package.json:38`, `.github/workflows/quality.yml:33` | `npm audit`: GHSA-mfr8-8qww-v76h، الإصلاح `16.4.6` | تسريب معلومات عبر root params؛ لا يمكن دمج أي PR لأن CI يفشل | ترقية Next إلى 16.4.6 وتحديث القفل | `npm audit --omit=dev --audit-level=low` يخرج بصفر | FIXED — `next`/`eslint-config-next` 16.4.6؛ `npm audit --omit=dev --audit-level=low` النهائي: `found 0 vulnerabilities` |
| A09 | غياب ترويسات أمان عامة (HSTS / X-Frame-Options / Referrer-Policy / nosniff) | `next.config.ts:3` | `headers()` يحتوي قاعدة `.apk` فقط | نقرة انتحال (clickjacking)، تسريب مرجعي، ضعف دفاع طبقي | إضافة ترويسات عامة مع السماح بالكاميرا لنفس الأصل فقط | اختبار: فحص ترويسات استجابة محلية | FIXED — `next.config.ts` + `tests/security-headers.test.mjs` |
| A10 |طلبات حساسة تقرأ جسم JSON بلا حد حجم | `app/api/member-access/route.ts:6`, `app/api/member-portal/route.ts:17` | `const body=await request.json();` | استهلاك الذاكرة/المعالج بطلب ضخم | قراءة نصية بحد 4–8 KB ثم `JSON.parse` مع تحقق نوع | اختبار: جسم 10 MB يُرفض بـ 413 | FIXED — حدود نصية 8 KB/4 KB/2 KB وتحقق نوع قبل `JSON.parse`؛ `tests/api-hardening-body.test.mjs` (4 pass) و`tests/api-hardening-password.test.mjs` (4 pass) |
| A11 | إعادة تعيين كلمة المرور تبني رابطًا من متغير عام غيرموثوق | `app/api/password/route.ts:9-11` | `process.env.NEXT_PUBLIC_DEV_SUPABASE_REDIRECT_URL??new URL('/auth/callback',request.url).href` | إرسال رابط إعادة تعيين لمرة واحدة إلى أصل مهاجم عند سوء الإعداد | استخدام أصل HTTPS موثوق (`siteOrigin()` / `authFlowOrigin()`) فقط ورفض القيم غير الصالحة | اختبار: ضبط المتغير على `https://evil.test` → يُرفض أو يُتجاهل | FIXED — `siteOrigin()` + `tests/password-recovery.test.mjs` |
| A12 | حد IP لتسجيل العضو يقرأ ترويسات قابلة للتزوير | `app/api/member-session/route.ts:14-15` | `x-vercel-forwarded-for??x-forwarded-for??'unknown'` | تجاوز حد 20 محاولة/IP بتغيير الترويسة | استخدام قيمة موثوقة من المنصة فقط، وتوحيد القيم المفصولة بفواصل | اختبار: 25 محاولة بترويسات دوّارة تُرفض بعد الحد | FIXED — `requestClientIp()` مع `GYMEG_TRUST_PROXY_IP` + `tests/security-origin.test.mjs`؛ `GYMEG_TRUST_PROXY_IP=1` أُضيف إلى Vercel، وسلوك المنصة الفعلي في النشر `UNVERIFIED` |
| A13 | تسجيل الخروج المحلي لا يُبطل الجلسات الأخرى | `app/api/session/route.ts:10` | `auth.auth.signOut({scope:'local'})` | جلساتaktyife على أجهزة أخرى بعد الخروج من جهاز مشترك | تسجيل خروج شامل/إبطال رموز التحديث، مع زر "تسجيل الخروج من كل الأجهزة" | اختبار: جهازان، خروج من أحدهما → الآخر 401 | FIXED محليًا — `signOut({scope:'global'})` في `app/api/session/route.ts`؛ `tests/api-hardening-session.test.mjs` (1 pass). الإبطال الفعلي لكل جلسات Supabase في الإنتاج `UNVERIFIED` |
| A14 | لا يوجد تحديد معدل على تسجيل الموظفين وإعادة تعيين كلمة المرور | `app/api/session/route.ts:16-21`, `app/api/password/route.ts:9-12` | لا عدّاد/429 في المسارين | تخمين كلمات المرور وإغراق البريد | تحديد معدل لكل بريد/IP مع `Retry-After` وتسجيل حدث أمني | اختبار: 100 طلب → 429 بعد الحد | FIXED محليًا — `app/lib/auth-rate-limit.ts` مع 429/`Retry-After`؛ `tests/api-hardening-password.test.mjs` (4 pass) و`tests/api-hardening-session.test.mjs` (3 pass). التخزين المشترك عبر نسخ الخدمة في الإنتاج `UNVERIFIED` |

### P1 — خلل أساسي يؤثر على التشغيل

| ID | المشكلة | الملف:السطر | الدليل | التأثير | الحل | اختبار التحقق | الحالة |
|---|---|---|---|---|---|---|---|
| B01 | سياسات RLS الأساسية تسمح بكل شيء (`USING(true)`) في تثبيت `db/*.sql` فقط | `db/postgres.sql:17-24`, `README.md:34` | `CREATE POLICY server_access ... USING(true) WITH CHECK(true)` و `npm run db:migrate` يثبّت الأساس فقط | أي مسار ينسى `withScope` يقرأ بيانات كل الأندية | سياسات مرتبطة بـ `app.gym_owner` + `FORCE ROW LEVEL SECURITY` في الأساس، مع سياسة ضيقة للدعوة | اختبار PGlite: مالك A لا يرى صفوف B بعد تثبيت الأساس فقط | FIXED — `db/postgres.sql` و`20261117130000_db_defense_in_depth.sql`؛ `tests/base-schema-rls.test.mjs` + `tests/db-defense-in-depth.test.mjs` |
| B02 | سياسة تحديث بوابة العضو تسمح بتغيير النادي/الفرع/البريد | `supabase/migrations/20261022212137_member_portal_messaging_presence.sql:14-16` | `WITH CHECK(owner_id=current_setting('app.gym_owner',true) OR (user_id=... AND invite_hash IS NULL ...))` | إعادة توجيه رابط العضو إلى نادٍ آخر | فصل سياسات المالك والعضو، ومنع تغيير الحقول الهوية عبر trigger | اختبار RLS: تحديث `branch`/`owner_id` من حساب العضو يُرفض | FIXED — سياسات منفصلة + `member_portal_identity_guard`؛ `tests/db-defense-in-depth.test.mjs` (1 pass) |
| B03 | سياسة تسجيل الدخول بالهاتف تكشف hash الـ PIN لكل النادي الذي يطابق الرقم | `supabase/migrations/20261023220355_member_phone_pin_signin.sql:4,27` | `CREATE POLICY ... USING(phone_hash=current_setting('app.member_phone',true))` مع SELECT كامل الصف | استخراجPin hashes وإجبارها دون اتصال | دالة/عرض ضيق يُعيد الأعمدة الآمنة فقط وإلغاء SELECT المباشر في سياسة الهاتف | اختبار RLS: `SELECT pin_hash` من دور التطبيق يُرفض | FIXED — `gymos.member_phone_login()` يُعيد ستة أعمدة آمنة فقط؛ `tests/db-defense-in-depth.test.mjs` (1 pass) |
| B04 | الترحيلات ليست idempotent وتُكرر cron | `supabase/migrations/20261019185320_commercial_partition_rls.sql:2`, `20261022213838_messaging_vault_scheduler.sql:36-39` | `DROP POLICY server_access` بدون `IF EXISTS`؛ `cron.schedule('gymos-whatsapp-worker',...)` بلا فحص | فشل إعادة الترحيل أو تكرار المهام وإرسال السر إلى مضيف غريب | `IF EXISTS`، حماية cron، وURL من إعداد/Vault | اختبار: تطبيق المجموعة مرتين على DB اختبار يمر دون أثر مزدوج | FIXED — الترحيلات الستة الحرجة replay-safe ومهام cron معطّلة عند التثبيت؛ `tests/full-bootstrap.test.mjs` (1 pass) |
| B05 | لا يوجد اختبار يثبت بناء قاعدة البيانات كاملة من الصفر | `scripts/migrate.mjs:7`, `app/api/health/route.ts:4` | السكربت يثبّت 3 ملفات فقط؛ الـ health يتحقق من جدول واحد | نشر يمرّ بترحيل ناقص ويفشل وقت التشغيل | سكربت bootstrap مرتب + اختبار CI يطبّق كل Migrations ويفحص الجداول/السياسات | اختبار: قاعدة فارغة → كل الجداول موجودة | FIXED محليًا — `tests/full-bootstrap.test.mjs` + `tests/db-bootstrap-helpers.mjs` يطبّقان الأساس وكل الترحيلات بالترتيب؛ إدراجه في CI `UNVERIFIED` حتى تشغيل البوابة النهائية |
| B06 | صفوف النسخ الاحتياطي المنتهية لا تُنظَّف | `app/lib/backup-transfer.ts:12`, `supabase/migrations/20261020183809_reliable_backups_activity_archive.sql:16` | الحذف يتم فقط لنفس المالك/المشغّل عند بدء عملية جديدة | بقاء حتى 64 MiB من بيانات الأعضاء بلا مبرر | حذف دوري لكل الصفوف المنتهية + تنظيف انتهازي | اختبار: إدراج صف منتهٍ وتشغيل التنظيف → يختفي | FIXED — `20261117134000_backup_transfer_expiry_cleanup.sql` + تنظيف انتهازي؛ `tests/backup-transfer-cleanup.test.mjs` (1 pass)؛ طُبّق في الإنتاج: `cleanup_fn=true` و`cleanup_job_active=false` عبر `cron.alter_job`؛ الاستدعاء اليدوي للدالة `UNVERIFIED` |
| B07 | مُجدول WhatsApp غير مضبوط في `vercel.json` | `vercel.json:1-11`, `app/api/cron/whatsapp/route.ts:5` | لا مفتاح `crons` | الرسائل المجدولة لا تُرسل تلقائيًا | إضافة cron مع ضبط `CRON_SECRET`، أو توثيق أن المجدول في Supabase فقط | اختبار: سجلات المنصة تُظهر استدعاءً دوريًا | FIXED في المصدر — cron في `vercel.json` بمسار `/api/cron/whatsapp` بالجدول `0 20 * * *` (يوميًا؛ لأن Hobby يرفض `*/5 * * * *`)، مع إبقاء بديل Vault الموقّع لمسار `pg_cron` المعطّل؛ `tests/api-hardening-cron.test.mjs` (5 pass). `CRON_SECRET` أُضيف إلى Vercel دون إظهار قيمته، لكن النشر لم يحدث وقيمة السر غير محفوظة محليًا؛ الاستدعاء الحي `UNVERIFIED` |
| B08 | أخطاء تطبيقية غير معالجة تُسقط واجهة كاملة إلى `mockPool` | `app/lib/database.ts:16-19,33-36` | `return mockPool` عند غياب `DATABASE_URL` أو خطأ التهيئة | نشر خاطئ يعرض بيانات فارغة بنجاح 200 بدل الفشل | فشل مغلق في production/preview، والسماح بـ mock فقط في test صراحةً | اختبار: تشغيل بدون `DATABASE_URL` في production يفشل | FIXED — `app/lib/database.ts` يمنع mock خارج test ما لم يُسمح صراحةً؛ `tests/database-fail-closed.test.mjs` |
| B09 | 7 اختبارات DB/RLS حرجة معطّلة افتراضيًا و3 suites تكامل يتية | `tests/backup-transfer.test.mjs:6`, `tests/commercial-postgres.test.mjs:4`, `scripts/run-integration-tests.mjs:8-25` | `skip:process.env.GYMOS_DB_TESTS!=='1'`، وسجلRunner يضم 16 من 19 | عزل المستأجرين والنسخ الاحتياطي غير مُختبَر في CI | إضافة Postgres مؤقت في CI وتشغيلها + معالجة السuites اليتيمة | اختبار: CI يُظهر 7 اختبارات إضافية ناجحة | FIXED محليًا — سجل شامل وكشف سuites يتيمة في `scripts/run-integration-tests.mjs`؛ `tests/api-hardening-scripts.test.mjs` (2 pass)، و`npm run test:integration`: 17 suite محلية ناجحة و3 خارجية مستبعدة. توفير Postgres مؤقت داخل CI `UNVERIFIED` |
| B10 | سكربتات تثبيت CI تستدعي `vinext` غير الموجود | `scripts/install-ci.sh:85-99,175-179`, `scripts/install-ci.mjs:38-49` | `node_modules/.bin/vinext` مطلوب وغير مدرج في الحزم | تثبيت نظيف يفشل | حذف/تحديث السكربتات القديمة | اختبار: تثبيت من clone نظيف ينجح | FIXED — إزالة استدعاءات `vinext` من `scripts/install-ci.sh` و`scripts/install-ci.mjs`، ووسم المراجع المتبقية كـ LEGACY؛ `tests/api-hardening-scripts.test.mjs` (2 pass) |
| B11 | واجهة WhatsApp لا تعالج STOP/ردود المستلمين ولا webhook للتسليم | `app/lib/whatsapp-server.ts:7-10`, `docs/WHATSAPP_SETUP_AR_EN.md:111` | إرسال فقط عبر Graph API بلا استقبال | إرسال لمن ألغى الموافقة؛ مخالفة محتملة لشروط المزوّد | إضافة webhook تحقق وإيقال موافقة، وتسجيل حالة التسليم | اختبار فعلي بحساب مزوّد (غير متاح محليًا) | FIXED محليًا — webhook موقّع GET/POST، تخزين STOP كـ digest، وحالات تسليم في `20261117138000_whatsapp_webhook_consent.sql`؛ `tests/whatsapp-webhook.test.mjs` (5 pass). التسجيل الحقيقي لدى Meta واستلام STOP/الإيصالات `UNVERIFIED` |
| B12 | تاريخ المصروف من العميل يختلف عن لحظة حركته النقدية | `app/lib/finance-book.ts:28,58`, `app/lib/domain.ts:62`, `app/lib/full-report.ts:20-26` | `day:op.day` مقابل `at:now` و `dayAt(x.at)` في أماكن أخرى | تقارير وإقفال يومي يتعارضان عند مصروف مؤرخ بأثر رجعي | اشتقاق اليوم من `dayAt(at)` أو تثبيت يوم واحد للكل | اختبار: مصروف نقدي بيوم أمس → نفس اليوم في التقرير والإقفال والوردية | FIXED — `bookDay(s,at)` و`assertCashOpen(s,branch,at)` واشتقاق اليوم من الطابع الزمني؛ `tests/finance-cash-day.test.mjs` (4 pass) و`tests/finance-post-close.test.mjs` (3 pass) |
| B13 | تغيير PIN العضو لا يتحقق من رخصة النادي | `app/api/member-pin/route.ts:13-18`, `app/lib/member-code-session.ts:1-3` | لا `licenseState(...).writable` مقارنة بـ `member-session/route.ts:22` | عضو في نادٍ موقوف يغيّر بيانات الدخول ويُنشئ جلسة 7 أيام | فحص الرخصة في المسار ودالة الجلسة | اختبار: تعليق الرخصة ثم تغيير PIN → 403 | FIXED — فحص رخصة في `app/api/member-pin/route.ts` + اختبار تكامل 403 |
| B14 | التحقق من المستأجر مفقود/مشروط في قراءات حساسة | `app/api/workspace/route.ts:13`, `app/api/presence/route.ts:5`, `app/api/member-photo/route.ts:5`, `app/api/member-portal/route.ts:10-16` | `if(request.headers.has('x-gymos-tenant'))assertRequestTenant(...)` | تبويب قديم يعرض بيانات نادٍ مختلف عن المحدد في الواجهة | استدعاء `assertRequestTenant` دائمًا (يسمح بالغياب في الوضع غير التجاري) | اختبار: كوكي A + ترويسة B → 409 | FIXED — `assertRequestTenant` غير مشروط في قراءات `workspace/presence/member-photo/member-portal`؛ `tests/api-hardening-tenant.test.mjs` (3 pass) |
| B15 | التحويلات المالية بعملات مختلفة تسمح بنفس رقم التحويل | `app/lib/commercial.ts:79-80`, `supabase/migrations/20261019185320_commercial_partition_rls.sql:25` | الفهرس الفريد على `(normalized_ref,currency)` | إثبات دفع واحد قد يعتمد لطلبين | جعل المرجع فريدًا عالميًا أو حسب الحساب البنكي | اختبار: طلبان بنفس المرجع وعملتين → يُرفض الثاني | FIXED — `20261117136000_global_transfer_reference.sql` + فحص موحّد في `app/lib/commercial.ts`؛ `tests/transfer-reference.test.mjs` (1 pass). فحص الإنتاج قبل الترحيل: `refs_total=0` و`duplicate_ref_rows=0`؛ والفهرس الصحيح `activation_requests_unique_transfer` مُثبت بعد الترحيل |

### P2 — تحسينات مهمة

| ID | المشكلة | الملف:السطر | الدليل | التأثير | الحل | الحالة |
|---|---|---|---|---|---|---|
| C01 | منح RLS في `tenants` يسمح بتغيير `storage_key` | `supabase/migrations/20261019183227_commercial_multiclub.sql:66` | `WITH CHECK(id=current_setting('app.tenant',true)...)` فقط على المعرّف | تغيير رابط التخزين يعزل بيانات النادي | فصل SELECT عن UPDATE ومنع تعديل الحقول الهوية | FIXED — `tenants_immutable_identity`trigger؛ `tests/db-defense-in-depth.test.mjs` (1 pass) |
| C02 | قيود المبالغ في بيانات الأعضاء موجودة في التطبيق فقط لا في DB | `app/lib/domain.ts:37,52`, `supabase/migrations/...unified_member_console.sql` | المدفوعات JSONB بلا CHECK | كتابة مباشرة/استيراد يُنشئ مبلغًا سالبًا | trigger للتحقق من `minor` في JSONB | FIXED — `20261117137000_payment_amount_guard.sql` + `tests/payment-amount-guard.test.mjs` (1 pass). طُبّق في الإنتاج: `invalid_minor_rows=0` قبل الترحيل و`amount_trigger=1` بعده |
| C03 | تهجير `branches` النصية قد تكون غير JSON فتُفشل الترحيل | `db/postgres.sql:4`, `supabase/migrations/20261019183227_commercial_multiclub.sql:50` | `a.branches::jsonb` مباشرة | نشر يفشل على بيانات قديمة | `CASE WHEN branches IS JSON ... ELSE '[]'::jsonb END` مع تسجيل الصفوف | FIXED — `gymos.safe_branches_json()` تُعيد `[]` (لا `NULL` الذي يعني كل الفروع) للقيمة غير الصالحة؛ `tests/branches-json-migration.test.mjs` (1 pass) |
| C04 | PIN افتراضي「مقبول بقرار مالك سابق」موثّق في عدة أدلة | `README.md:107`, `docs/MEMBER_APP_CONNECTED_AR_EN.md:3`, `docs/COMMERCIAL_READINESS_2026-11-05_AR.md:58` | نصوص صريحة بتثبيت `123456` | تعارض مع متطلبات الأمان الحالية | تحديث الوثائق بعد الترحيل | FIXED — `docs/MEMBER_PIN_SECURITY_2026-11-17_AR_EN.md` وتحديث الأدلة النشطة؛ الوثائق التاريخية موسومة كملغاة |
| C05 | تفعيل لiveness بدون anti-spoof | `app/face-attendance.tsx:11` | `antispoof:{enabled:false},liveness:{enabled:true}` | صورة/فيديو قد تمرّ؛ لا شهادة دقة حيوية | توثيق الحد صراحةً وقياسه على الجهاز | OPEN |
| C06 | seguridad WebView الأصلية تعتمد على أصل الويب فقط | `mobile-android/management/.../MainActivity.java:58`, `windows/MainWindow.xaml.cs:26`, `ios-support/GymOSAnnouncementScheduler.swift:39-62` | لا تحقق رمز/توقيع للطلبات الأصلية، ومعرّف الملف `id+'.wav'` بلا تعقيم | XSS على الأصل يُكتب ملفات داخل sandbox ويتحكم بالإعلانات | HMAC قصير الأمد + تعقيد المعرّف + حد حجم | OPEN |
| C07 | أصوات/Android جدولة الإعلانات بلا `WAKE_LOCK` | `mobile-android/management/AndroidManifest.xml:4`, `android-support/AndroidManifest.xml:4-5` | استخدام `newWakeLock().acquire()` بدون إذن مُعلن | استثناء `SecurityException` يمنع الإعلان المجدول | إضافة الأذونات وبناء APK جديد والتحقق على جهاز | OPEN |
| C08 | ترويسات/مخططات قديمة في `vite.config.ts` و`scripts/install-ci*` | `vite.config.ts:1-6` | يستورد `vinext` و`build/` غير الموجودين | أوامر قديمة تفشل | إزالة أو تحديث | FIXED — `vite.config.ts` فارغ بلا استيراد، والمراجع المتبقية موسومة LEGACY/SUPERSEDED؛ `tests/legacy-config.test.mjs` (2 pass) |
| C09 | بقاء ملفات تحقق قديمة تدّعي أرقامًا لا تطابق الحالية | `TEST_REPORT.md:5`, `PRODUCT_REVIEW_2026-10-20.md:48-52` | 36/43/47/53 مقابل 289 test حاليًا، ومراجع ملفات غير موجودة | ثقة زائفة في سجل التحقق | وسمها `SUPERSEDED` وربطها بالتقرير الجديد | FIXED — لافتة ثنائية اللغة في `TEST_REPORT.md` و`PRODUCT_REVIEW_2026-10-20.md` دون تعديل سجلها التاريخي؛ `tests/legacy-config.test.mjs` (1 pass) |
| C10 | استخدام `confirm()/prompt()` لتأكيد عمليات خطيرة | `app/member-console.tsx:71`, `app/backup-panel.tsx:12`, `app/team-page.tsx:15` وغيرها | لا حوار يمكن الوصول إليه رغم وجود `components/ui/alert-dialog.tsx` | صعوبة الاستخدام بلوحة المفاتيح وقارئ الشاشة | استبدال بمكوّن الحوار المتاح | FIXED — `components/ui/use-confirm-dialog.tsx` يعتمد على Radix `AlertDialog`، واستُخدم في 12 واجهة؛ `tests/ux-hardening-confirm-dialogs.test.mjs` (5 pass)، و`npm run typecheck` و`npm run lint -- --max-warnings 0` ناجحان |
| C11 | نصوص عربية ثابتة تتجاهل تبديل اللغة | `app/member-console.tsx:37,53,72`, `app/demo/page.tsx:3` | نصوص مباشرة بدل `t(...)` | واجهة إنجليزية جزئية | تغليف النصوص بـ `t` | FIXED — تمرير اللغة صراحةً إلى `member-console` ودعم `?lang=en` في `/demo`؛ `tests/ux-hardening-language.test.mjs` (4 pass)، و`tests/member-console-ui.integration.mjs` (20 pass)، و`tests/usability.integration.mjs` (14 pass) |
| C12 | توزيع مفتاح Firebase العام في 3 ملفات `google-services.json` | `mobile-android/*/google-services.json:12`, `android-support/google-services.json:12` | `AIzaSyDI-lcaykNL_6B0k9hj6LiD4UK9GPsW2Lw` | إساءة استخدام الحصة إن لم يكن مقيدًا | تقييد المفتاح ببصمات التطبيقات/App Check | OPEN |
| C13 | Windows غير موقّع رقميًا ولا يوجد تحديث تلقائي | `README.md:49`, `scripts/publish-windows-release.mjs:41,49` | إفصاح صريح | تحذير SmartScreen وغياب هوية ناشر | شهادة توقيع + signtool + قناة تحديث موقّعة | OPEN |
| C14 | قيود التقارير (سنة/50k حدث) مقابل وصف «تقارير كاملة» | `app/api/reports/export/route.ts:11`, `README.md:87` | حدود صريحة في الكود | تصدير فترات أطول غير متاح | توثيق الحد أو رفعه مع pagination | FIXED (توثيق لا رفع) — `README.md` و`app/reports-page.tsx` يوضّحان 366 يومًا/50,000 حدث/10,000 صف، مع `message` و`cap` في أخطاء 400/413؛ `tests/ux-hardening-report-caps.test.mjs` (3 pass). لا يوجد وعد بـ pagination |

### P3 — تحسينات اختيارية/نظافة

- D01: سياسة `member_code_login` القديمة تتجاهل `revoked/inactive` ولا يوجد من يستخدمها (`20261023213044_member_private_code_sessions.sql:21`).
- D02: مقارنة رمز cron غير ثابتة الزمن (`20261022213838_messaging_vault_scheduler.sql:29-31`).
- D03: APKs قديمة بنسخ مختلفة لكن بنفس البايتات — FIXED — `public/downloads/apk-supersessions.json` يعلن الترتيب، و`tests/release-integrity-supersessions.test.mjs` (4 pass) يمنع إعلان نسخة قديمة ويؤكد تطابق البايتات.
- D04: `release:check` لا يتحقق من `sourceHashes` ولا من شهادة التوقيع الفعلية — FIXED جزئيًا — فحص موحّد للـ hashes وسمات الإصدار واختيار أداة التحقق أُضيف في `scripts/check-release-consistency.mjs`/`scripts/release-integrity.mjs`؛ `tests/release-integrity-consistency.test.mjs` (6 pass). شهادة التوقيع الفعلية ما زالت `UNVERIFIED` لغياب `apksigner` محليًا.
- D05: `sendSupportFcm` معرّف لكنه غير موصول بأي مستدعٍ — FIXED — حُذف المرسل غير المستخدم من `app/lib/firebase-messaging.ts`؛ `tests/release-integrity-fcm.test.mjs` (1 pass). إرسال FCM الحقيقي `UNVERIFIED`.
- D06: `vercel.json` يعطّل فرعًا قديمًا بالاسم (`vercel.json:6-9`).
- D07: `.npmrc:1` يوقف تدقيق الحزم افتراضيًا.
- D08: `GET /api/member-session` و`app/api/auth/[...all]` واجهات متقاعدة ما زالت مُصدَّرة.
- D09: تخزين FCM token بنص صريح في SharedPreferences (`mobile-android/*/FcmMessageService.java:19`).
- D10: DPAPI بلا entropy إضافي (`windows/BackupStore.cs:9-10`).

## 3. ما ثبت أنه صحيح (يُحافظ عليه)

- هوية المستخدم تُجلب من `auth.getUser()` في كل طلب محمي (`app/lib/verified-user.ts:5`)، ولا توجد أدوار من `user_metadata`.
- لا مفتاح service-role ولا مفتاح خاص ولا كلمة مرور في الكود/الوثائق؛ مفاتيح Firebase في ملفات Android هي معرّفات عامة بالتصميم.
- استعلامات SQL مُعلَّمة بالمعاملات؛ لم يُعثر على حقن SQL في مسارات API.
- `FORCE ROW LEVEL SECURITY` + `REVOKE FROM PUBLIC,anon,authenticated` على الجداول الحديثة، و SECURITY DEFINER مع `search_path` ثابت.
- مبالغ صحيحة بالبنسات، قفل صفّي/revision في `persistSpace` و`commercial.ts`، ودقة في تقارير `full-report.ts`.
- تشفير اشتراكات Push ورموز FCM، ونطاقات endpoint مسموحة، وتنظيف 404/410.
- حماية WebView: بلا `addJavascriptInterface`، بلا cleartext، بلا file/content access، ورفض أخطاء SSL، وسجلات موقّعة، و hashes APK مطابقة للبيانات الوصفية (تحقّق فعلي بـ `Get-FileHash`).
- 364 اختبارًا محليًا نجحت ضمن 371 اختبارًا مسجّلًا (7 suites خارجية مستبعدة)، ولا توجد اختبارات `.only` أو assertions وهمية.

## 4. ما ثبت في الإنتاج وما زال UNVERIFIED

### ثبت في إنتاج Supabase
1. الترحيلات السبعة `20261117120000` إلى `20261117138000` طُبّقت وسُجّلت في `schema_migrations`، مع فحص قبل/بعد موثّق في القسم 6.
2. shared PINs انخفضت من 181 إلى 0، ودوال تسجيل الدخول وتنظيف النسخ الاحتياطي موجودة، ومهمة تنظيف cron معطّلة عبر `cron.alter_job`.
3. مراجع التحويل والمبالغ غير الصالحة كانت صفرًا قبل الترحيل، والفهارس/المحفّزات المطلوبة موجودة بعده.
4. Supabase Auth: Site URL `https://gymeg.vercel.app`، و3 redirect URLs فقط بعد حذف روابط `pushtorq.vercel.app` القديمة، مع حفظ التغييرات وإعادة التحميل.

### ما زال UNVERIFIED صراحةً
1. نشر فرع `fix/production-readiness-2026-11-17` على Vercel: الإنتاج الحالي ما زال `main@cf2e2ad`، ولا توجد نتيجة نشر للفرع بعد.
2. استدعاء `/api/cron/whatsapp` الحي وجدولة Vercel الفعلية؛ قيمة `CRON_SECRET` غير محفوظة محليًا والنشر لم يكتمل.
3. تسجيل webhook لدى Meta، والتوقيع الفعلي، و`App Secret` و`Verify Token`، وSTOP والإيصالات بحساب حقيقي — حسب قرار المالك تُترك `UNVERIFIED` دون قيم وهمية.
4. ما إذا كانت المنصة تُعيد كتابة ترويسات `x-forwarded-*` الواردة في النشر الفعلي.
5. الإبطال الفعلي لكل جلسات Supabase، والتخزين المشترك لحد المعدل عبر نسخ الإنتاج.
6. قيمة ciphertext قديمة غير مقروءة واحدة على الأقل خارج نطاق PINs المشتركة؛ لم تُعدَّد أو تُعالَج خارج النطاق المطلوب.
7. التسليم الحقيقي لـ SMS/FCM/WebPush، وقيود مفاتيح المزوّدين.
8. التركيب على أجهزة Android/Windows فعلية، الكاميرا/الماسح/الطابعة/الصوت، وتوقيع APK/EXE.
9. استعادة نسخة احتياطية ببيانات فعلية، وأي عملية مالية حقيقية.

## 5. حصيلة البوابات المحلية النهائية (قبل النشر)

| البوابة | النتيجة |
|---|---|
| `npm run typecheck` | ناجح |
| `npm run lint -- --max-warnings 0` | 0 أخطاء، 0 تحذيرات |
| `npm test` | 371 اختبارًا؛ 364 نجاحًا، 0 فشل، 7 مستبعدة (متطلبات DB/مزوّد خارجية) |
| `npm run test:integration` | 17 suite محلية ناجحة؛ 3 suites خارجية مستبعدة؛ 6 suites DB-gated مستبعدة داخل `npm test` |
| `npm run release:check` | ناجح؛ شهادات توقيع APK `UNVERIFIED` لغياب `apksigner` |
| `npm audit --omit=dev --audit-level=low` | `found 0 vulnerabilities` |
| `npm run build` | ناجح على Next.js 16.4.6؛ 34 صفحة مولّدة |

لم يُنفَّذ أي نشر للتطبيق أو عملية مالية حقيقية، ولا PR ولا دمج. دُفع الفرع إلى `origin/fix/production-readiness-2026-11-17`.

## 6. سجل التحقق في الإنتاج (17 نوفمبر 2026)

**البيئة:** Supabase org `ahmedmorgan86's Org` (FREE)، project `GymEG`، ref `frsstuqstutbflkaffcx`، region `eu-west-1`، branch `main`، موسوم `PRODUCTION`. Vercel project `gymeg`، team `ahmedmorgan86s-projects`، URL `https://gymeg.vercel.app/`.

### أ) الفحص قبل الترحيل

| الفحص | النتيجة |
|---|---|
| ترحيلات `20261117*` المعلّقة | 0 صف |
| `refs_total` / `duplicate_ref_rows` / `invalid_minor_rows` | 0 / 0 / 0 |
| `non_json_states` | 0 |
| `pin_accounts` / `shared_pin_accounts` | 183 / 181 |
| `owners` / `member_key_secrets` / `pin_owner_count` | 2 / 4 / 2 |
| `backup_transfers_ready` / `cron_ready` / `pgcrypto_ready` | true / true / true |

لم تُحذف أي صفوف تلقائيًا؛ الفحوص أظهرت أن الترحيلات يمكن تطبيقها دون تعارض مرجعي أو مبلغ غير صالح.

### ب) محاولة فاشلة ثم إصلاحها

أُجريت محاولة أولى لتطبيق ترحيل PIN من مصدر سابق ففشلت بـ `Failed to run sql query: ERROR: 39000: Wrong key or corrupt data` داخل `gymos.member_code_decrypt(text)`. تحققت إمكانية التراجع في محرر SQL: `hardened_pin_fn=false`، و`shared_pins=181`، و`recorded_migrations=0`. بعد ذلك استُبدل decryption بكشف PIN المشترك من الـ hash دون فك النص المشفر في `20261117120000_remove_shared_member_pins.sql`، مع اختبار انحدار يمنع استدعاء `member_code_decrypt`.

### ج) الترحيلات المطبقة

طُبّقت الترحيلات السبعة التالية من مصدر SHA `9f1f6f4253aafe1cdfa1bac0a718b2ca9dc5ad63` بنجاح، وسُجّلت يدويًا في `supabase_migrations.schema_migrations` بعد ظهور أثرها:

- `20261117120000` — remove shared member PINs
- `20261117130000` — db defense in depth
- `20261117134000` — backup transfer expiry cleanup
- `20261117135000` — owner scoped membership cards
- `20261117136000` — global transfer reference
- `20261117137000` — payment amount guard
- `20261117138000` — whatsapp webhook consent

التحقق النهائي: `recorded_migrations=7` مع الإصدارات السبعة المذكورة أعلاه.

### د) الحالة بعد الترحيل

| الفحص | النتيجة |
|---|---|
| `pin_fn` / `shared_pins` | true / 0 |
| `login_fn` / `cleanup_fn` | true / true |
| `cleanup_job_active` | false |
| `card_pk2` | 1 |
| `activation_requests_unique_transfer` | الفهرس الصحيح موجود |
| `amount_trigger` / `whatsapp_optouts` | 1 / 1 |

مهمة التنظيف عُطّلت باستخدام الواجهة المدعومة `cron.alter_job(job_id, active => false)` وليس بتعديل `cron.job` مباشرة.

### هـ) Supabase Auth

بعد إعادة التحميل ثبت: Site URL `https://gymeg.vercel.app`؛ 3 redirect URLs فقط؛ Signups enabled؛ Manual linking disabled؛ Anonymous sign-ins disabled؛ Confirm email enabled؛ Email enabled؛ Phone disabled؛ Secure email change enabled؛ Secure password change disabled؛ Require current password disabled؛ Magic links/Email OTP enabled. حُذفت 3 روابط قديمة `https://pushtorq.vercel.app/auth/callback*` وحُفظت التغييرات. المعدلات عند الافتراضي، وIP forwarding وCaptcha غير مفعّلين. leaked-password protection غير متاح على الخطة Free.

### و) Vercel

أُضيفت متغيرات البيئة دون إظهار قيمها: `CRON_SECRET` (secret، وُلّد وعدم الاحتفاظ بقيمته محليًا) و`GYMEG_TRUST_PROXY_IP=1` (config). فحص `vercel.json` أظهر مسار `/api/cron/whatsapp` بالجدول `*/5 * * * *`، ثم رفض Vercel النشر لأن حساب Hobby يسمح بتشغيل يومي واحد فقط؛ صُحّح الجدول إلى `0 20 * * *` (يوميًا) دون ترقية مدفوعة ودون إيقاف الميزة. كما رفض Vercel الالتزام `d2e361c` أولًا لأن مؤلفه `engineering@gymeg.local` غير موثّق؛ أُعيد الدفع بـ commit بمؤلف `41932609+ahmedmorgan86@users.noreply.github.com` الموثّق، فانتقل Vercel إلى محاولة النشر. بعد هاتين المحاولتين نُشرت معاينة الـ PR بنجاح (`Ready`،Deployment `HorUrKEgaxEUMfimLb6biwJFvbzq`) وصارت حالة `Vercel` `success` وكل فحوص الـ PR ناجحة؛ أما الإنتاج فما زال `main@cf2e2ad` ولم يُدمج الـ PR. مباشرة API لإنشاء deployment من المتصفح أُوقفت سابقًا بـ `403 challenge_required`. استدعاء cron الحي ما زال `UNVERIFIED`. عولج تحذير Build Logs الوحيد (`npm warn deprecated eslint@9.39.4`) برفع `eslint` من `9.39.4` (EOL) إلى `10.15.0`؛ ولمنع تحذيرات النقاء المتبادلة من إضافات `eslint-config-next` التي لم تُعلن بعد دعم eslint 10 أُضيف `legacy-peer-deps=true` إلى `.npmrc` مع الحفاظ على إعداداته الأصلية. لكن ذلك النشر الأول (`f14461a`) فشل في Vercel لأن `legacy-peer-deps` يمنع تثبيت حزم النقاء المعلنة `peer: true` تلقائيًا (`@zxing/library` و`react-is` و`ts-custom-error`)، فأُعلن `Module not found: Can't resolve '@zxing/library'`؛ صُحّح بإعلان `@zxing/library@^0.23.0` و`react-is@^19.3.1` صراحةً في `dependencies` (هما مطلوبان أصلًا لبناء `@zxing/browser` و`recharts`) فأصبحت القفلة بلا أي إدخال `peer: true`. البيئات تطابق متطلب eslint 10 (`Node 24.x` محليًا وفي CI وعلى Vercel). التحقق النهائي بعد التثبيت النظيف: `npm ci` بصفر تحذيرات، و`npm run build` ناجح بصفر أسطر تحذير، و`lint --max-warnings 0` و`typecheck` و`test` (364 نجاحًا، 0 فشل) كلها ناجحة.

### ز) حدود صريحة

لا توجد بيانات Meta App Secret أو Verify Token، ولم تُضف قيم وهمية؛ webhook واستلام STOP والإيصالات تبقى `UNVERIFIED`. لا توجد أجهزة فعلية أو شهادات توقيع أو `apksigner` أو Authenticode، فتبقى بوابات العميل `UNVERIFIED`، و`C05–C07` و`C12–C13` `OPEN`. `app/lib/auth-rate-limit.ts` ما زال لكل عملية خدمة وحدها؛ لا يوجد إثبات لسجل مشترك عبر نسخ الإنتاج. لم تُجرَّ أي عملية مالية حقيقية.
