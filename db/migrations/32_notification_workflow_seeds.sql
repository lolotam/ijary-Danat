-- 32_notification_workflow_seeds.sql
-- Seeds for notification workflows (Twilio provider, report schedules, templates).
--
-- PREREQUISITE: migration 31 must have completed successfully and **committed**.
-- Postgres will reject INSERTs that use new enum labels if ADD VALUE was never
-- committed (typical when 31 aborted mid-script).
--
-- Before running this file, verify:
--
--   SELECT e.enumlabel
--   FROM pg_enum e
--   JOIN pg_type t ON t.oid = e.enumtypid
--   WHERE t.typname = 'notification_providers'
--   ORDER BY e.enumsortorder;
--
-- You must see: smtp, resend, whatsapp_cloud_api, **twilio**.
-- If twilio is missing, re-run 31 (now fixed), or run once:
--
--   ALTER TYPE public.notification_providers ADD VALUE IF NOT EXISTS 'twilio';
--   ALTER TYPE public.notification_types ADD VALUE IF NOT EXISTS 'deposit_confirmation';
--   ALTER TYPE public.notification_types ADD VALUE IF NOT EXISTS 'user_credentials';
--   ALTER TYPE public.notification_types ADD VALUE IF NOT EXISTS 'payment_admin_alert';
--
-- Commit that, then run this file.
-- Idempotent.

------------------------------------------------------------
-- Twilio provider seed
------------------------------------------------------------

insert into public.provider_configs (provider, is_enabled, config) values
  (
    'twilio',
    false,
    '{
      "account_sid_env":"TWILIO_ACCOUNT_SID",
      "secret_env":"TWILIO_AUTH_TOKEN",
      "from_whatsapp_env":"TWILIO_WHATSAPP_FROM"
    }'::jsonb
  )
on conflict (provider) do nothing;

------------------------------------------------------------
-- Default weekly + monthly admin report schedules
------------------------------------------------------------

insert into public.report_schedules (
  code, name_ar, name_en, frequency, recipients, locale, is_active, next_run_at
) values
  (
    'weekly-admin-report',
    'التقرير الأسبوعي للإدارة',
    'Weekly Admin Report',
    'weekly',
    '[]'::jsonb,
    'ar',
    false,
    now() + interval '1 day'
  ),
  (
    'monthly-admin-report',
    'التقرير الشهري للإدارة',
    'Monthly Admin Report',
    'monthly',
    '[]'::jsonb,
    'ar',
    false,
    (date_trunc('month', now()) + interval '1 month')::timestamptz
  )
on conflict (code) do nothing;

------------------------------------------------------------
-- Extra notification templates
------------------------------------------------------------

insert into public.notification_templates (
  code, type, channel, locale, subject_ar, subject_en, body_ar, body_en
) values
  (
    'deposit-confirmation-ar',
    'deposit_confirmation',
    'email',
    'ar',
    'تأكيد إيداع بنكي {{amount}}',
    'Bank deposit confirmed {{amount}}',
    'تم تأكيد إيداع بمبلغ {{amount}} في {{bank_name}} بتاريخ {{deposit_date}}. الرمز: {{code}}.',
    'A bank deposit of {{amount}} at {{bank_name}} on {{deposit_date}} was confirmed. Code: {{code}}.'
  ),
  (
    'deposit-confirmation-en',
    'deposit_confirmation',
    'email',
    'en',
    'تأكيد إيداع بنكي {{amount}}',
    'Bank deposit confirmed {{amount}}',
    'تم تأكيد إيداع بمبلغ {{amount}} في {{bank_name}} بتاريخ {{deposit_date}}. الرمز: {{code}}.',
    'A bank deposit of {{amount}} at {{bank_name}} on {{deposit_date}} was confirmed. Code: {{code}}.'
  ),
  (
    'user-credentials-ar',
    'user_credentials',
    'both',
    'ar',
    'بيانات الدخول — {{display_name}}',
    'Login credentials — {{display_name}}',
    'مرحباً {{display_name}}، بيانات الدخول: {{username}} / {{password}}. الرابط: {{login_url}}',
    'Hello {{display_name}}, credentials: {{username}} / {{password}}. Link: {{login_url}}'
  ),
  (
    'user-credentials-en',
    'user_credentials',
    'both',
    'en',
    'بيانات الدخول — {{display_name}}',
    'Login credentials — {{display_name}}',
    'مرحباً {{display_name}}، بيانات الدخول: {{username}} / {{password}}. الرابط: {{login_url}}',
    'Hello {{display_name}}, credentials: {{username}} / {{password}}. Link: {{login_url}}'
  ),
  (
    'payment-admin-alert-ar',
    'payment_admin_alert',
    'email',
    'ar',
    'دفعة مستأجر — {{tenant_name}}',
    'Tenant payment — {{tenant_name}}',
    'دفع المستأجر {{tenant_name}} مبلغ {{amount}} عن الفترات: {{periods}}.',
    'Tenant {{tenant_name}} paid {{amount}} for periods: {{periods}}.'
  ),
  (
    'payment-admin-alert-en',
    'payment_admin_alert',
    'email',
    'en',
    'دفعة مستأجر — {{tenant_name}}',
    'Tenant payment — {{tenant_name}}',
    'دفع المستأجر {{tenant_name}} مبلغ {{amount}} عن الفترات: {{periods}}.',
    'Tenant {{tenant_name}} paid {{amount}} for periods: {{periods}}.'
  )
on conflict (code) do update set
  subject_ar = excluded.subject_ar,
  subject_en = excluded.subject_en,
  body_ar = excluded.body_ar,
  body_en = excluded.body_en,
  type = excluded.type;
