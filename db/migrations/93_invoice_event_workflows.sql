-- ---------------------------------------------------------------------------
-- 93 - invoice write-off / dispute event workflows and email templates
-- ---------------------------------------------------------------------------
--
-- Depends on migration 92 having COMMITTED: it uses the enum values 92 adds, and
-- a new enum value cannot be used in the transaction that created it.
--
-- Rationale: a write-off and a dispute are both moments where money stops being
-- expected to arrive. Those are exactly the transitions an owner wants to see,
-- and they are currently invisible outside the audit log.
--
-- EMAIL-ONLY BY DESIGN. These are internal operational notices (admin + company).
-- Do NOT set provider_template_name / provider_param_keys. Migration 38 made the
-- WhatsApp sender REFUSE to send without those columns; migration 58 documents
-- the trap: contract expiry WhatsApp was silently dead for months because no
-- migration seeded them. If anyone later inserts a channel='whatsapp' row for
-- invoice_written_off / invoice_disputed without registering and getting Meta
-- approval for the template name, it will look configured and silently send
-- nothing. Keep these email-only unless you deliberately complete that Meta
-- path first.
--
-- `do update` deliberately does NOT touch is_active on either table: replaying
-- must never silently re-enable a workflow an admin switched off.

insert into public.cron_jobs (
  key, kind, name_ar, name_en, description_ar, description_en, recipient_targets
)
values
  (
    'invoice-written-off', 'event',
    'شطب فاتورة', 'Invoice written off',
    'يرسل إلى مستلمي الإدارة عند شطب فاتورة (waived).',
    'Emails the admin recipients when an invoice is written off (waived).',
    array['admin','company']::text[]
  ),
  (
    'invoice-disputed', 'event',
    'نزاع على فاتورة', 'Invoice disputed',
    'يرسل إلى مستلمي الإدارة عند وضع علامة نزاع على فاتورة.',
    'Emails the admin recipients when an invoice is marked disputed.',
    array['admin','company']::text[]
  )
on conflict (key) do update
  set kind = excluded.kind,
      name_ar = excluded.name_ar,
      name_en = excluded.name_en,
      description_ar = excluded.description_ar,
      description_en = excluded.description_en,
      recipient_targets = excluded.recipient_targets;

insert into public.notification_templates (
  code, type, channel, locale, subject_ar, subject_en, body_ar, body_en
) values
  (
    'invoice-written-off-ar', 'invoice_written_off', 'email', 'ar',
    'شطب فاتورة - {{invoice_code}}', 'Invoice written off - {{invoice_code}}',
    '<p>تم شطب فاتورة.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>المستأجر:</strong> {{tenant_name}}</li><li><strong>رقم الفاتورة:</strong> {{invoice_code}}</li><li><strong>المبلغ المشطوب:</strong> {{amount}}</li><li><strong>السبب:</strong> {{reason}}</li><li><strong>رقم العقد:</strong> {{contract_code}}</li></ul>',
    '<p>An invoice has been written off.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>Tenant:</strong> {{tenant_name}}</li><li><strong>Invoice code:</strong> {{invoice_code}}</li><li><strong>Amount written off:</strong> {{amount}}</li><li><strong>Reason:</strong> {{reason}}</li><li><strong>Contract code:</strong> {{contract_code}}</li></ul>'
  ),
  (
    'invoice-written-off-en', 'invoice_written_off', 'email', 'en',
    'شطب فاتورة - {{invoice_code}}', 'Invoice written off - {{invoice_code}}',
    '<p>تم شطب فاتورة.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>المستأجر:</strong> {{tenant_name}}</li><li><strong>رقم الفاتورة:</strong> {{invoice_code}}</li><li><strong>المبلغ المشطوب:</strong> {{amount}}</li><li><strong>السبب:</strong> {{reason}}</li><li><strong>رقم العقد:</strong> {{contract_code}}</li></ul>',
    '<p>An invoice has been written off.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>Tenant:</strong> {{tenant_name}}</li><li><strong>Invoice code:</strong> {{invoice_code}}</li><li><strong>Amount written off:</strong> {{amount}}</li><li><strong>Reason:</strong> {{reason}}</li><li><strong>Contract code:</strong> {{contract_code}}</li></ul>'
  ),
  (
    'invoice-disputed-ar', 'invoice_disputed', 'email', 'ar',
    'نزاع على فاتورة - {{invoice_code}}', 'Invoice disputed - {{invoice_code}}',
    '<p>وُضعت علامة نزاع على فاتورة.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>المستأجر:</strong> {{tenant_name}}</li><li><strong>رقم الفاتورة:</strong> {{invoice_code}}</li><li><strong>الرصيد:</strong> {{amount}}</li><li><strong>السبب:</strong> {{reason}}</li><li><strong>رقم العقد:</strong> {{contract_code}}</li></ul>',
    '<p>An invoice has been marked disputed.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>Tenant:</strong> {{tenant_name}}</li><li><strong>Invoice code:</strong> {{invoice_code}}</li><li><strong>Balance:</strong> {{amount}}</li><li><strong>Reason:</strong> {{reason}}</li><li><strong>Contract code:</strong> {{contract_code}}</li></ul>'
  ),
  (
    'invoice-disputed-en', 'invoice_disputed', 'email', 'en',
    'نزاع على فاتورة - {{invoice_code}}', 'Invoice disputed - {{invoice_code}}',
    '<p>وُضعت علامة نزاع على فاتورة.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>المستأجر:</strong> {{tenant_name}}</li><li><strong>رقم الفاتورة:</strong> {{invoice_code}}</li><li><strong>الرصيد:</strong> {{amount}}</li><li><strong>السبب:</strong> {{reason}}</li><li><strong>رقم العقد:</strong> {{contract_code}}</li></ul>',
    '<p>An invoice has been marked disputed.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>Tenant:</strong> {{tenant_name}}</li><li><strong>Invoice code:</strong> {{invoice_code}}</li><li><strong>Balance:</strong> {{amount}}</li><li><strong>Reason:</strong> {{reason}}</li><li><strong>Contract code:</strong> {{contract_code}}</li></ul>'
  )
on conflict (code) do update
  set subject_ar = excluded.subject_ar,
      subject_en = excluded.subject_en,
      body_ar = excluded.body_ar,
      body_en = excluded.body_en;
