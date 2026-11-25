# خطة تشغيل وتراجع ترحيل طلبات الدعم (PostgreSQL / Supabase)

## 1. الغرض
إضافة جداول `gymos.support_requests` و`gymos.support_request_messages` و`gymos.support_request_updates` مع تفعيل سياسات `FORCE ROW LEVEL SECURITY` لدور `gymos_app` عبر الترحيل:
- `supabase/migrations/20261125000000_support_requests.sql`

## 2. خطوات التشغيل الآمن (بعد الحصول على إذن مستقل)
1. أخذ نسخة احتياطية سريعة أو التأكد من نقطة استعادة (PITR / Snapshot) على Supabase.
2. تنفيذ الترحيل على القاعدة المستضافة (عبر `supabase db push` أو SQL Editor بصلاحية المالك):
   - ينشئ الجداول الثلاثة والفهارس وقواعد RLS بدور `gymos_app` دون المساس بأي جداول أخرى.
3. فحص بعد التنفيذ (Verification):
   ```sql
   SELECT to_regclass('gymos.support_requests') IS NOT NULL AS requests_ready,
          to_regclass('gymos.support_request_messages') IS NOT NULL AS messages_ready,
          to_regclass('gymos.support_request_updates') IS NOT NULL AS updates_ready;
   ```

## 3. خطة التراجع (Rollback)
في حال الحاجة للتراجع الفوري (مع العلم أنه يحذف بيانات طلبات الدعم الجديدة فقط ولا يمس أي بيانات أندية أو اشتراكات):
```sql
DROP TABLE IF EXISTS gymos.support_request_updates CASCADE;
DROP TABLE IF EXISTS gymos.support_request_messages CASCADE;
DROP TABLE IF EXISTS gymos.support_requests CASCADE;
```

## 4. اختبار ما بعد النشر
- فتح `/support-requests` بحساب اختبار غير إداري -> التأكد من عدم ظهور رسالة عدم التوفر ومن إمكانية إنشاء طلب (`201`) دون `503`.
- فتح `/support-requests?platform=1` بحساب منصة -> تولّي الطلب، الرد، وإغلاقه (`resolved`).
