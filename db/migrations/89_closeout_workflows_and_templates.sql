-- ---------------------------------------------------------------------------
-- 89 - close-out / restore event workflows and email templates
-- ---------------------------------------------------------------------------
--
-- Depends on migration 88 having COMMITTED: it uses the enum values 88 adds, and
-- a new enum value cannot be used in the transaction that created it.
--
-- EMAIL-ONLY BY DESIGN. These are internal operational notices (admin + company).
-- Do NOT set provider_template_name / provider_param_keys. Migration 38 made the
-- WhatsApp sender REFUSE to send without those columns; migration 58 documents
-- the trap: contract expiry WhatsApp was silently dead for months because no
-- migration seeded them. If anyone later inserts a channel='whatsapp' row for
-- contract_closeout / contract_restored without registering and getting Meta
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
    'contract-closeout-completed', 'event',
    'إكمال إغلاق عقد', 'Contract close-out completed',
    'يرسل إلى مستلمي الإدارة عند إكمال معالج إغلاق العقد.',
    'Emails the admin recipients when a contract close-out is committed.',
    array['admin','company']::text[]
  ),
  (
    'contract-restored', 'event',
    'استعادة عقد من الأرشيف', 'Contract restored',
    'يرسل إلى مستلمي الإدارة عند إعادة عقد مؤرشف إلى القوائم التشغيلية.',
    'Emails the admin recipients when an archived contract is restored to operational lists.',
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
    'contract-closeout-ar', 'contract_closeout', 'email', 'ar',
    'إغلاق عقد - {{contract_code}}', 'Contract close-out - {{contract_code}}',
    '<p>تم إكمال إغلاق عقد.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>المستأجر:</strong> {{tenant_name}}</li><li><strong>رقم العقد:</strong> {{contract_code}}</li><li><strong>معرّف الإغلاق:</strong> {{closeout_id}}</li><li><strong>النتيجة:</strong> {{outcome}}</li><li><strong>تاريخ المغادرة:</strong> {{move_out_date}}</li><li><strong>مبلغ الاسترداد:</strong> {{refund_total}}</li><li><strong>المتبقي على المستأجر:</strong> {{balance_due}}</li></ul>',
    '<p>A contract close-out has been completed.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>Tenant:</strong> {{tenant_name}}</li><li><strong>Contract code:</strong> {{contract_code}}</li><li><strong>Close-out id:</strong> {{closeout_id}}</li><li><strong>Outcome:</strong> {{outcome}}</li><li><strong>Move-out date:</strong> {{move_out_date}}</li><li><strong>Refund total:</strong> {{refund_total}}</li><li><strong>Balance due:</strong> {{balance_due}}</li></ul>'
  ),
  (
    'contract-closeout-en', 'contract_closeout', 'email', 'en',
    'إغلاق عقد - {{contract_code}}', 'Contract close-out - {{contract_code}}',
    '<p>تم إكمال إغلاق عقد.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>المستأجر:</strong> {{tenant_name}}</li><li><strong>رقم العقد:</strong> {{contract_code}}</li><li><strong>معرّف الإغلاق:</strong> {{closeout_id}}</li><li><strong>النتيجة:</strong> {{outcome}}</li><li><strong>تاريخ المغادرة:</strong> {{move_out_date}}</li><li><strong>مبلغ الاسترداد:</strong> {{refund_total}}</li><li><strong>المتبقي على المستأجر:</strong> {{balance_due}}</li></ul>',
    '<p>A contract close-out has been completed.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>Tenant:</strong> {{tenant_name}}</li><li><strong>Contract code:</strong> {{contract_code}}</li><li><strong>Close-out id:</strong> {{closeout_id}}</li><li><strong>Outcome:</strong> {{outcome}}</li><li><strong>Move-out date:</strong> {{move_out_date}}</li><li><strong>Refund total:</strong> {{refund_total}}</li><li><strong>Balance due:</strong> {{balance_due}}</li></ul>'
  ),
  (
    'contract-restored-ar', 'contract_restored', 'email', 'ar',
    'استعادة عقد - {{contract_code}}', 'Contract restored - {{contract_code}}',
    '<p>أُعيد عقد إلى القوائم التشغيلية.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>المستأجر:</strong> {{tenant_name}}</li><li><strong>رقم العقد:</strong> {{contract_code}}</li><li><strong>الحالة المستهدفة:</strong> {{target_state}}</li><li><strong>السبب:</strong> {{reason}}</li></ul>',
    '<p>A contract has been restored to operational lists.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>Tenant:</strong> {{tenant_name}}</li><li><strong>Contract code:</strong> {{contract_code}}</li><li><strong>Target state:</strong> {{target_state}}</li><li><strong>Reason:</strong> {{reason}}</li></ul>'
  ),
  (
    'contract-restored-en', 'contract_restored', 'email', 'en',
    'استعادة عقد - {{contract_code}}', 'Contract restored - {{contract_code}}',
    '<p>أُعيد عقد إلى القوائم التشغيلية.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>المستأجر:</strong> {{tenant_name}}</li><li><strong>رقم العقد:</strong> {{contract_code}}</li><li><strong>الحالة المستهدفة:</strong> {{target_state}}</li><li><strong>السبب:</strong> {{reason}}</li></ul>',
    '<p>A contract has been restored to operational lists.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>Tenant:</strong> {{tenant_name}}</li><li><strong>Contract code:</strong> {{contract_code}}</li><li><strong>Target state:</strong> {{target_state}}</li><li><strong>Reason:</strong> {{reason}}</li></ul>'
  )
on conflict (code) do update
  set subject_ar = excluded.subject_ar,
      subject_en = excluded.subject_en,
      body_ar = excluded.body_ar,
      body_en = excluded.body_en;
