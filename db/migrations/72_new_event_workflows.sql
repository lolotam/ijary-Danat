-- ---------------------------------------------------------------------------
-- 72 - five event workflows: contact inquiry, maintenance, refund, contract
-- ---------------------------------------------------------------------------
--
-- Depends on migration 71 having COMMITTED: it uses the enum values 71 adds, and
-- a new enum value cannot be used in the transaction that created it.
--
-- Contract created and ended are two rows, not one. They are different triggers
-- on different code paths, and independent switchability is the point of the
-- registry - an admin who wants terminations but not every new contract must be
-- able to say so.
--
-- `do update` deliberately does NOT touch is_active on either table: replaying
-- must never silently re-enable a workflow an admin switched off.

insert into public.cron_jobs (key, kind, name_ar, name_en, description_ar, description_en)
values
  ('contact-inquiry-received', 'event',
   'استلام طلب تواصل', 'Contact inquiry received',
   'يرسل إلى مستلمي الإدارة عندما يرسل زائر نموذج التواصل.',
   'Emails the admin recipients when a visitor submits the contact form.'),
  ('maintenance-request-created', 'event',
   'إنشاء طلب صيانة', 'Maintenance request created',
   'يرسل إلى مستلمي الإدارة عند تسجيل طلب صيانة جديد.',
   'Emails the admin recipients when a maintenance request is logged.'),
  ('refund-recorded', 'event',
   'تسجيل استرداد مبلغ', 'Refund recorded',
   'يرسل إلى مستلمي الإدارة عند تطبيق استرداد مبلغ.',
   'Emails the admin recipients when a refund is applied.'),
  ('contract-created', 'event',
   'إنشاء عقد', 'Contract created',
   'يرسل إلى مستلمي الإدارة عند إنشاء عقد جديد.',
   'Emails the admin recipients when a contract is created.'),
  ('contract-ended', 'event',
   'انتهاء عقد', 'Contract ended',
   'يرسل إلى مستلمي الإدارة عندما ينتقل العقد إلى حالة منتهية.',
   'Emails the admin recipients when a contract transitions into an ended state.')
on conflict (key) do update
  set kind = excluded.kind,
      name_ar = excluded.name_ar,
      name_en = excluded.name_en,
      description_ar = excluded.description_ar,
      description_en = excluded.description_en;

insert into public.notification_templates (
  code, type, channel, locale, subject_ar, subject_en, body_ar, body_en
) values
  (
    'contact-inquiry-ar', 'contact_inquiry', 'email', 'ar',
    'طلب تواصل جديد - {{name}}', 'New contact inquiry - {{name}}',
    '<p>تم استلام طلب تواصل جديد.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>الاسم:</strong> {{name}}</li><li><strong>البريد:</strong> {{email}}</li><li><strong>الهاتف:</strong> {{phone}}</li></ul><p><strong>الرسالة:</strong></p><p>{{message}}</p>',
    '<p>A new contact inquiry has been received.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>Name:</strong> {{name}}</li><li><strong>Email:</strong> {{email}}</li><li><strong>Phone:</strong> {{phone}}</li></ul><p><strong>Message:</strong></p><p>{{message}}</p>'
  ),
  (
    'contact-inquiry-en', 'contact_inquiry', 'email', 'en',
    'طلب تواصل جديد - {{name}}', 'New contact inquiry - {{name}}',
    '<p>تم استلام طلب تواصل جديد.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>الاسم:</strong> {{name}}</li><li><strong>البريد:</strong> {{email}}</li><li><strong>الهاتف:</strong> {{phone}}</li></ul><p><strong>الرسالة:</strong></p><p>{{message}}</p>',
    '<p>A new contact inquiry has been received.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>Name:</strong> {{name}}</li><li><strong>Email:</strong> {{email}}</li><li><strong>Phone:</strong> {{phone}}</li></ul><p><strong>Message:</strong></p><p>{{message}}</p>'
  ),
  (
    'maintenance-request-ar', 'maintenance_request', 'email', 'ar',
    'طلب صيانة جديد - {{code}}', 'New maintenance request - {{code}}',
    '<p>تم تسجيل طلب صيانة جديد.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>رقم الطلب:</strong> {{code}}</li><li><strong>العنوان:</strong> {{title}}</li><li><strong>الوحدة:</strong> {{unit_name}}</li><li><strong>الأولوية:</strong> {{priority}}</li></ul>',
    '<p>A new maintenance request has been logged.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>Request code:</strong> {{code}}</li><li><strong>Title:</strong> {{title}}</li><li><strong>Unit:</strong> {{unit_name}}</li><li><strong>Priority:</strong> {{priority}}</li></ul>'
  ),
  (
    'maintenance-request-en', 'maintenance_request', 'email', 'en',
    'طلب صيانة جديد - {{code}}', 'New maintenance request - {{code}}',
    '<p>تم تسجيل طلب صيانة جديد.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>رقم الطلب:</strong> {{code}}</li><li><strong>العنوان:</strong> {{title}}</li><li><strong>الوحدة:</strong> {{unit_name}}</li><li><strong>الأولوية:</strong> {{priority}}</li></ul>',
    '<p>A new maintenance request has been logged.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>Request code:</strong> {{code}}</li><li><strong>Title:</strong> {{title}}</li><li><strong>Unit:</strong> {{unit_name}}</li><li><strong>Priority:</strong> {{priority}}</li></ul>'
  ),
  (
    'refund-recorded-ar', 'refund_recorded', 'email', 'ar',
    'تم تسجيل استرداد - {{code}}', 'Refund recorded - {{code}}',
    '<p>تم تسجيل استرداد مبلغ.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>المستأجر:</strong> {{tenant_name}}</li><li><strong>المبلغ:</strong> {{amount}}</li><li><strong>السبب:</strong> {{reason}}</li><li><strong>الرقم:</strong> {{code}}</li></ul>',
    '<p>A refund has been recorded.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>Tenant:</strong> {{tenant_name}}</li><li><strong>Amount:</strong> {{amount}}</li><li><strong>Reason:</strong> {{reason}}</li><li><strong>Code:</strong> {{code}}</li></ul>'
  ),
  (
    'refund-recorded-en', 'refund_recorded', 'email', 'en',
    'تم تسجيل استرداد - {{code}}', 'Refund recorded - {{code}}',
    '<p>تم تسجيل استرداد مبلغ.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>المستأجر:</strong> {{tenant_name}}</li><li><strong>المبلغ:</strong> {{amount}}</li><li><strong>السبب:</strong> {{reason}}</li><li><strong>الرقم:</strong> {{code}}</li></ul>',
    '<p>A refund has been recorded.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>Tenant:</strong> {{tenant_name}}</li><li><strong>Amount:</strong> {{amount}}</li><li><strong>Reason:</strong> {{reason}}</li><li><strong>Code:</strong> {{code}}</li></ul>'
  ),
  (
    'contract-created-ar', 'contract_created', 'email', 'ar',
    'عقد جديد - {{contract_code}}', 'Contract created - {{contract_code}}',
    '<p>تم إنشاء عقد جديد.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>المستأجر:</strong> {{tenant_name}}</li><li><strong>رقم العقد:</strong> {{contract_code}}</li><li><strong>الوحدة:</strong> {{unit_name}}</li><li><strong>تاريخ البداية:</strong> {{start_date}}</li><li><strong>تاريخ الانتهاء:</strong> {{end_date}}</li></ul>',
    '<p>A new contract has been created.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>Tenant:</strong> {{tenant_name}}</li><li><strong>Contract code:</strong> {{contract_code}}</li><li><strong>Unit:</strong> {{unit_name}}</li><li><strong>Start date:</strong> {{start_date}}</li><li><strong>End date:</strong> {{end_date}}</li></ul>'
  ),
  (
    'contract-created-en', 'contract_created', 'email', 'en',
    'عقد جديد - {{contract_code}}', 'Contract created - {{contract_code}}',
    '<p>تم إنشاء عقد جديد.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>المستأجر:</strong> {{tenant_name}}</li><li><strong>رقم العقد:</strong> {{contract_code}}</li><li><strong>الوحدة:</strong> {{unit_name}}</li><li><strong>تاريخ البداية:</strong> {{start_date}}</li><li><strong>تاريخ الانتهاء:</strong> {{end_date}}</li></ul>',
    '<p>A new contract has been created.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>Tenant:</strong> {{tenant_name}}</li><li><strong>Contract code:</strong> {{contract_code}}</li><li><strong>Unit:</strong> {{unit_name}}</li><li><strong>Start date:</strong> {{start_date}}</li><li><strong>End date:</strong> {{end_date}}</li></ul>'
  ),
  (
    'contract-ended-ar', 'contract_ended', 'email', 'ar',
    'انتهاء عقد - {{contract_code}}', 'Contract ended - {{contract_code}}',
    '<p>انتقل عقد إلى حالة منتهية.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>المستأجر:</strong> {{tenant_name}}</li><li><strong>رقم العقد:</strong> {{contract_code}}</li><li><strong>الوحدة:</strong> {{unit_name}}</li><li><strong>تاريخ الانتهاء:</strong> {{end_date}}</li></ul>',
    '<p>A contract has transitioned into an ended state.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>Tenant:</strong> {{tenant_name}}</li><li><strong>Contract code:</strong> {{contract_code}}</li><li><strong>Unit:</strong> {{unit_name}}</li><li><strong>End date:</strong> {{end_date}}</li></ul>'
  ),
  (
    'contract-ended-en', 'contract_ended', 'email', 'en',
    'انتهاء عقد - {{contract_code}}', 'Contract ended - {{contract_code}}',
    '<p>انتقل عقد إلى حالة منتهية.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>المستأجر:</strong> {{tenant_name}}</li><li><strong>رقم العقد:</strong> {{contract_code}}</li><li><strong>الوحدة:</strong> {{unit_name}}</li><li><strong>تاريخ الانتهاء:</strong> {{end_date}}</li></ul>',
    '<p>A contract has transitioned into an ended state.</p><ul style="padding-inline-start:20px;line-height:1.9;"><li><strong>Tenant:</strong> {{tenant_name}}</li><li><strong>Contract code:</strong> {{contract_code}}</li><li><strong>Unit:</strong> {{unit_name}}</li><li><strong>End date:</strong> {{end_date}}</li></ul>'
  )
on conflict (code) do update
  set subject_ar = excluded.subject_ar,
      subject_en = excluded.subject_en,
      body_ar = excluded.body_ar,
      body_en = excluded.body_en;
