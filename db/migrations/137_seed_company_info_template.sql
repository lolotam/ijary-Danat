-- 137_seed_company_info_template.sql
--
-- `sendCompanyInfo` writes notifications.template_code = 'company-info'.
-- That column is an FK onto notification_templates.code, and migration 47
-- only added the `company_info` enum value — it deliberately did not seed a
-- row (the comment there said an admin would create company-info-ar /
-- company-info-en through Settings). The sender never used those suffixed
-- codes, so every send crashed on the FK.
--
-- Idempotent: ON CONFLICT DO NOTHING. Replaying must not reset an admin
-- edit or re-enable a template they turned off.
--
-- Locale is gone as of migration 125; one row holds both subject/body
-- columns. Bodies carry {{placeholders}} so they stay consistent with the
-- migration-70 suite, which rejects any template whose body has none.

insert into public.notification_templates (
  code, type, channel, is_active,
  subject_ar, subject_en, body_ar, body_en
) values (
  'company-info',
  'company_info',
  'both',
  true,
  'معلومات الشركة',
  'Company information',
  $ar$<p>عزيزي {{tenant_name}}،</p>
<p>تجدون مرفقًا معلومات التواصل والتفاصيل البنكية لشركتنا {{company_name}}.</p>$ar$,
  $en$<p>Dear {{tenant_name}},</p>
<p>Please find attached the contact and bank details for {{company_name}}.</p>$en$
)
on conflict (code) do nothing;
