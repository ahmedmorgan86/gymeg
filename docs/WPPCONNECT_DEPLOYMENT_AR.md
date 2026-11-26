# دليل تشغيل وتكامل WPPConnect Multi-Tenant مع GYMEG

## 1. المعمارية (Architecture)
- **تطبيق الويب والـ API (`Next.js` على Vercel):** يدير صلاحيات الأندية والفروع، قواعد الإشعارات، طابور الرسائل (`whatsapp_outbox`)، صندوق المحادثات (`whatsapp_inbox`)، والردود التلقائية (`whatsapp_auto_replies`).
- **خادم `Always-On Worker` (`infra/wppconnect/worker`):** خدمة Node.js 22 دائمة التشغيل، تتصل بـ GYMEG عبر HTTPS + توقيع HMAC-SHA256 (`X-GymEG-Worker-Signature` + `X-GymEG-Worker-Timestamp` لمنع Replay Attacks) باستخدام أسلوب Pull/Polling كل 15 ثانية.
- **خادم `WPPConnect Server` (`wppconnect/wppconnect-server:2.10.99`):** يعمل معزولاً داخل شبكة Docker الداخلية (`wpp_internal`) ولا يُكشف للإنترنت العام، ويدير جلسات Chromium المستقلة لكل نادٍ وفرع.

> **تنبيه مهم:** تكامل WPPConnect غير رسمي ويعتمد على WhatsApp Web؛ لا يمكن ضمان عدم فرض قيود أو حظر من واتساب عند الاستخدام المكثف أو إرسال رسائل جماعية غير مرغوب فيها. استخدم دائماً موافقة الأعضاء الصريحة (Opt-in) والحد اليومي للإرسال.

---

## 2. متغيرات البيئة المطلوبة (Environment Variables)

### على Vercel (تطبيق GYMEG):
- `GYMEG_WPP_WORKER_SECRET`: مفتاح سري عشوائي (64 حرف hex) لتوقيع اتصالات الـ Worker.

### على خادم Docker (`infra/wppconnect/.env`):
راجع الملف النموذجي [infra/wppconnect/.env.example](../infra/wppconnect/.env.example):
- `GYMEG_API_BASE_URL=https://your-gymeg-domain.vercel.app`
- `GYMEG_WPP_WORKER_SECRET=<نفس المفتاح الموجود في Vercel>`
- `WPP_SECRET_KEY=<مفتاح سري داخلي لـ WPPConnect Server>`
- `WORKER_POLL_INTERVAL_MS=15000`

---

## 3. التشغيل عبر Docker (Linux AMD64)

```bash
cd infra/wppconnect
cp .env.example .env
# عدّل .env وأضف الأسرار القوية
docker compose up -d --build
docker compose ps
docker compose logs -f gymeg-worker
```

### ملاحظة حول Oracle Cloud Always Free (ARM64)
- صورة `wppconnect/wppconnect-server:2.10.99` مبنية على Alpine Linux وتثبّت `chromium` من مستودعات Alpine، لكن يجب التحقق فعلياً من توافق حزمة Chromium على بيئة `ARM64` المستهدفة قبل الاعتماد الإنتاجي.
- الاستضافة المجانية 24/7 غير مضمونة من المزودين؛ إذا توقف السيرفر يتوقف الإرسال وتبقى الرسائل في الطابور بأمان لحين عودة التشغيل.

---

## 4. تقدير الموارد المطلوبة (Resource Estimate)
*(تقديرات إرشادية وليست ضماناً، وتعتمد على نشاط المحادثات وحجم الوسائط):*
- **النظام + Worker + جلسة واحدة:** ~1.5 إلى 2 GB RAM و1–2 vCPU.
- **كل جلسة/نادي/فرع إضافي (تبويب Chromium):** ~300 إلى 500 MB RAM إضافية.
- لـ 5–8 جلسات نشطة متزامنة يُنصح بخادم **4 GB RAM / 2 vCPU** على الأقل.

---

## 5. النسخ الاحتياطي والاستعادة (Backup & Restore)
```bash
# نسخ احتياطي لمجلدات الجلسات والتوكنات:
docker run --rm -v wppconnect_tokens:/data -v $(pwd):/backup alpine tar czf /backup/wpp-tokens.tar.gz /data
docker run --rm -v wppconnect_user_data:/data -v $(pwd):/backup alpine tar czf /backup/wpp-userdata.tar.gz /data
```

---

## 6. خطوات ربط رقم واتساب عبر QR Code
1. سجّل الدخول إلى GYMEG كمالك أو مدير النادي وافتح **واتساب النادي**.
2. من تبويب **الإعدادات** اختر `WPPConnect Self-Hosted (QR)` واضبط الحد اليومي ثم احفظ.
3. من تبويب **الاتصال** اضغط **ربط رقم واتساب**.
4. خلال ثوانٍ يظهر **QR Code** (يتم التحديث تلقائياً كل 3 ثوانٍ).
5. امسح الرمز من تطبيق واتساب على الهاتف (**الأجهزة المرتبطة / Linked Devices**).
6. تتحول الحالة إلى **CONNECTED** ويظهر الرقم المتصل، وتستمر الجلسة في العمل حتى بعد إغلاق المتصفح.

---

## 7. ملخص الأمان (Security Summary)
- **عزل Multi-Tenant:** `FORCE ROW LEVEL SECURITY` على جميع الجداول (`whatsapp_provider_connections`, `whatsapp_inbox`, `whatsapp_messages`, `whatsapp_auto_replies`, `whatsapp_audit_logs`) مقيداً بـ `app.gym_owner` أو `app.messaging_worker`.
- **أسماء الجلسات:** مشتقة بـ HMAC-SHA256 (`gym_<24hex>`) غير قابلة للتنبؤ.
- **توثيق الـ Worker:** توقيع HMAC-SHA256 مع نافذة زمنية 5 دقائق (`anti-replay`).
- **حماية SSRF والموافقات:** منع عناوين الشبكة الداخلية في Webhooks، احترام إلغاء الموافقة (`STOP`/`إلغاء`)، وعدم إعادة إرسال الحالات غير المؤكدة (`unknown`) تلقائياً.
