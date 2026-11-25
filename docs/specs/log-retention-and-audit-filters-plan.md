# خطة التنفيذ: الحذف التلقائي + فلاتر التدقيق + حجم الصفحة

المواصفة: [`log-retention-and-audit-filters.md`](./log-retention-and-audit-filters.md)

## 1. قاعدة البيانات — `db/migrations/242_log_retention.sql`

1. أعمدة `companies.audit_log_retention_days` و`notification_log_retention_days` + CHECK.
2. `purge_log(p_log, p_days)` داخلية (لا grant) — تحذف وترجع العدد.
3. `set_log_retention(p_log, p_days)` — authenticated، تفحص الصلاحية، تحفظ، تحذف فوراً، تدقّق.
4. `purge_expired_logs()` — service_role فقط، للـ cron.
5. `audit_log_filter_options()` — security invoker، stable.
6. صف `cron_jobs` للمفتاح `log-retention`.
7. اختبار SQL: `src/db/logRetention.sqltest.ts`.

## 2. السيرفر

1. `src/fns/logRetentionJob.ts` + اختبار.
2. تسجيلها في `JOBS` (`src/fns/cronJobs.ts`) و`WORKFLOW_CATALOG`.
3. `database.types.ts`: الأعمدة والدوال الجديدة (يدوياً).
4. `deploy/README.md`: سطر crontab الجديد.

## 3. الواجهة

1. `Pager`: خاصية `pageSizeOptions`.
2. `src/lib/auditLabels.ts` + اختبار — ترجمة الإجراء/الكيان/الدور.
3. مفاتيح الترجمة: ملف جديد `locales/{ar,en}/audit.ts`.
4. `useAuditLogs`: فلاتر جديدة + `useAuditFilterOptions` + prefetch.
5. `useLogRetention` (قراءة من `useCompany` + mutation للـ RPC).
6. `components/admin/LogRetentionCard.tsx` — مشترك للصفحتين، مع تأكيد قبل الحذف.
7. `components/admin/audit/AuditFiltersPanel.tsx` (فصل من صفحة التدقيق للحفاظ على الحجم).
8. `/admin/audit` و`/admin/settings/notifications`: ربط كل ما سبق.

## 4. التحقق

- `bun run lint && bun run typecheck && bun run test`.
- `bun run test:sql` يحتاج Docker (غير متاح هنا) — يُشغَّل قبل الدمج.

## 5. خطوات الإنتاج (بعد الدمج)

1. `pg_dump -t public.audit_logs -t public.notifications` احتياطاً.
2. تطبيق `242_log_retention.sql` + `notify pgrst, 'reload schema'` (انظر CLAUDE.md).
3. إضافة السطر إلى `/etc/cron.d/danat-ermp`:
   `0 2 * * * root /usr/local/bin/danat-cron log-retention`
4. من الواجهة: تفعيل الحذف التلقائي واختيار المدة.
