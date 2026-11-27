-- 328_notification_skip_reason.sql (T129)
--
-- يضيف عمود `skip_reason` إلى جدول `notifications` لتسجيل سبب تخطّي الإشعار
-- (مثل بلوغ الحد الشهري لواتساب أو تعطيل الوحدة أو تعليق الشركة) مع قيد
-- يضمن أن سبب التخطّي لا يُكتب إلا عندما تكون الحالة `skipped`.
--
-- Per data-model.md (`notifications.skip_reason`) and tasks.md T129:
--   - `skip_reason` is nullable text restricted to
--     `('limit_reached', 'module_disabled', 'company_suspended')`.
--   - `skip_reason` may only be non-null when `state = 'skipped'`.
--
-- Rollback:
--   alter table public.notifications drop constraint if exists notifications_skip_reason_requires_skipped;
--   alter table public.notifications drop constraint if exists notifications_skip_reason_check;
--   alter table public.notifications drop column if exists skip_reason;

alter table public.notifications
  add column if not exists skip_reason text;

alter table public.notifications
  drop constraint if exists notifications_skip_reason_check;

alter table public.notifications
  add constraint notifications_skip_reason_check
  check (skip_reason in ('limit_reached', 'module_disabled', 'company_suspended'));

alter table public.notifications
  drop constraint if exists notifications_skip_reason_requires_skipped;

alter table public.notifications
  add constraint notifications_skip_reason_requires_skipped
  check (skip_reason is null or state = 'skipped');
