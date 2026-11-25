-- ---------------------------------------------------------------------------
-- 70 — seed every template body so it reproduces the builder's current output
-- ---------------------------------------------------------------------------
--
-- Making templates authoritative means the stored body replaces the builder's
-- inner content entirely. Seeding bodies that already reproduce today's emails
-- is what makes that switch safe: on the day it ships, every email is the same
-- as it was, and nothing changes until an admin edits a template.
--
-- Bodies are INNER CONTENT — renderEmailDocument wraps them in the branded
-- shell. A body that starts with <!doctype or <html is used verbatim instead.
--
-- `update`, not `insert … on conflict`: all 16 rows already exist, and update
-- cannot create a duplicate or reset is_active.
--
-- Mirror of these strings: src/lib/__fixtures__/seededBodies.ts

-- receipt
update public.notification_templates
set
  subject_ar = 'إيصال دفع — {{reference}}',
  subject_en = 'Payment receipt — {{reference}}',
  body_ar = $ar$
<p>شكراً لك {{tenant_name}}، تم تسجيل دفعتك بنجاح.</p>
       <ul style="padding-inline-start:20px;line-height:1.9;">
         <li><strong>المبلغ:</strong> {{amount}}</li>
         <li><strong>التاريخ:</strong> {{payment_date}}</li>
         <li><strong>المرجع:</strong> {{reference}}</li>
       </ul>
$ar$,
  body_en = $en$
<p>Thank you, {{tenant_name}}. Your payment has been recorded.</p>
       <ul style="padding-inline-start:20px;line-height:1.9;">
         <li><strong>Amount:</strong> {{amount}}</li>
         <li><strong>Date:</strong> {{payment_date}}</li>
         <li><strong>Reference:</strong> {{reference}}</li>
       </ul>
$en$
where code in ('receipt-ar', 'receipt-en');

-- overdue-reminder
update public.notification_templates
set
  subject_ar = 'تذكير بمبالغ متأخرة ({{days_overdue}} يوم)',
  subject_en = 'Overdue balance reminder ({{days_overdue}} days)',
  body_ar = $ar$
<p>عزيزي {{tenant_name}}،</p>
       <p>لدينا رصيد متأخر على حسابك بقيمة <strong>{{outstanding}}</strong> منذ {{days_overdue}} يوماً. يرجى المبادرة بالسداد لتفادي أي إجراءات إضافية.</p>
$ar$,
  body_en = $en$
<p>Dear {{tenant_name}},</p>
       <p>You have an overdue balance of <strong>{{outstanding}}</strong> that is {{days_overdue}} days past due. Please settle at your earliest convenience.</p>
$en$
where code in ('overdue-reminder-ar', 'overdue-reminder-en');

-- contract-expiry
update public.notification_templates
set
  subject_ar = 'تنبيه انتهاء العقد {{contract_code}}',
  subject_en = 'Contract {{contract_code}} expiry notice',
  body_ar = $ar$
<p>مرحباً {{tenant_name}}،</p>
       <p>ينتهي عقدك رقم <strong>{{contract_code}}</strong> بتاريخ <strong>{{end_date}}</strong>. يرجى التواصل معنا لمناقشة التجديد أو الإخلاء.</p>
$ar$,
  body_en = $en$
<p>Hello {{tenant_name}},</p>
       <p>Your contract <strong>{{contract_code}}</strong> is scheduled to end on <strong>{{end_date}}</strong>. Please contact us to arrange renewal or handover.</p>
$en$
where code in ('contract-expiry-ar', 'contract-expiry-en');

-- deposit-confirmation
update public.notification_templates
set
  subject_ar = 'تأكيد إيداع بنكي — {{code}}',
  subject_en = 'Bank deposit confirmed — {{code}}',
  body_ar = $ar$
<p>تم تأكيد إيداع بنكي جديد في النظام.</p>
       <ul style="padding-inline-start:20px;line-height:1.9;">
         <li><strong>المبلغ:</strong> {{amount}}</li>
         <li><strong>البنك:</strong> {{bank_name}}</li>
         <li><strong>التاريخ:</strong> {{deposit_date}}</li>
         <li><strong>الرمز:</strong> {{code}}</li>
         <li><strong>ملاحظة:</strong> {{note}}</li>
       </ul>
$ar$,
  body_en = $en$
<p>A bank deposit has been confirmed in the system.</p>
       <ul style="padding-inline-start:20px;line-height:1.9;">
         <li><strong>Amount:</strong> {{amount}}</li>
         <li><strong>Bank:</strong> {{bank_name}}</li>
         <li><strong>Date:</strong> {{deposit_date}}</li>
         <li><strong>Code:</strong> {{code}}</li>
         <li><strong>Note:</strong> {{note}}</li>
       </ul>
$en$
where code in ('deposit-confirmation-ar', 'deposit-confirmation-en');

-- payment-admin-alert
update public.notification_templates
set
  subject_ar = 'دفعة مستأجر — {{tenant_name}}',
  subject_en = 'Tenant payment — {{tenant_name}}',
  body_ar = $ar$
<p>قام المستأجر <strong>{{tenant_name}}</strong> بسداد مبلغ <strong>{{amount}}</strong>.</p>
       <p><strong>الفترات:</strong> {{periods}}</p>
       <p><strong>أكواد الدفع:</strong> {{payment_codes}}</p>
$ar$,
  body_en = $en$
<p>Tenant <strong>{{tenant_name}}</strong> paid <strong>{{amount}}</strong>.</p>
       <p><strong>Periods:</strong> {{periods}}</p>
       <p><strong>Payment codes:</strong> {{payment_codes}}</p>
$en$
where code in ('payment-admin-alert-ar', 'payment-admin-alert-en');

-- invoice-document
update public.notification_templates
set
  subject_ar = 'فاتورتك #{{invoice_number}}',
  subject_en = 'Your invoice #{{invoice_number}}',
  body_ar = $ar$
<p>مرحباً {{tenant_name}}، هذه نسخة من فاتورتك.</p>
       <table style="width:100%;border-collapse:collapse;background:#f5f2ec;border-radius:8px;overflow:hidden;margin-bottom:16px;">
         <tr><td style="padding:8px 12px;color:#6b6b6b;">رقم الفاتورة</td><td style="padding:8px 12px;font-weight:600;text-align:end;">{{invoice_number}}</td></tr>
         <tr><td style="padding:8px 12px;color:#6b6b6b;">المستأجر</td><td style="padding:8px 12px;font-weight:600;text-align:end;">{{tenant_name}}</td></tr>
         <tr><td style="padding:8px 12px;color:#6b6b6b;">الوحدة</td><td style="padding:8px 12px;font-weight:600;text-align:end;">{{unit_name}}</td></tr>
         <tr><td style="padding:8px 12px;color:#6b6b6b;">العقار</td><td style="padding:8px 12px;font-weight:600;text-align:end;">{{property_name}}</td></tr>
         <tr><td style="padding:8px 12px;color:#6b6b6b;">الفترة</td><td style="padding:8px 12px;font-weight:600;text-align:end;">{{period}}</td></tr>
         <tr><td style="padding:8px 12px;color:#6b6b6b;">تاريخ الإصدار</td><td style="padding:8px 12px;font-weight:600;text-align:end;">{{issue_date}}</td></tr>
         <tr><td style="padding:8px 12px;color:#6b6b6b;">تاريخ الاستحقاق</td><td style="padding:8px 12px;font-weight:600;text-align:end;">{{due_date}}</td></tr>
       </table>
       <table style="width:100%;border-collapse:collapse;">
         <tr><td style="padding:8px 12px;color:#6b6b6b;">الإجمالي قبل الخصم</td><td style="padding:8px 12px;text-align:end;font-weight:600;">{{subtotal}}</td></tr>
         <tr><td style="padding:8px 12px;color:#6b6b6b;">الخصم</td><td style="padding:8px 12px;text-align:end;font-weight:600;">{{discount}}</td></tr>
         <tr><td style="padding:8px 12px;color:#6b6b6b;">المدفوع</td><td style="padding:8px 12px;text-align:end;font-weight:600;">{{paid}}</td></tr>
         <tr style="border-top:2px solid #0f3d2e;"><td style="padding:12px;font-weight:800;font-size:16px;">الإجمالي المستحق</td><td style="padding:12px;text-align:end;font-weight:800;font-size:16px;">{{total}}</td></tr>
       </table>
       <p style="color:#6b6b6b;font-size:13px;margin-top:20px;">{{footer}}</p>
$ar$,
  body_en = $en$
<p>Hello {{tenant_name}}, here is a copy of your invoice.</p>
       <table style="width:100%;border-collapse:collapse;background:#f5f2ec;border-radius:8px;overflow:hidden;margin-bottom:16px;">
         <tr><td style="padding:8px 12px;color:#6b6b6b;">Invoice</td><td style="padding:8px 12px;font-weight:600;text-align:end;">{{invoice_number}}</td></tr>
         <tr><td style="padding:8px 12px;color:#6b6b6b;">Tenant</td><td style="padding:8px 12px;font-weight:600;text-align:end;">{{tenant_name}}</td></tr>
         <tr><td style="padding:8px 12px;color:#6b6b6b;">Unit</td><td style="padding:8px 12px;font-weight:600;text-align:end;">{{unit_name}}</td></tr>
         <tr><td style="padding:8px 12px;color:#6b6b6b;">Property</td><td style="padding:8px 12px;font-weight:600;text-align:end;">{{property_name}}</td></tr>
         <tr><td style="padding:8px 12px;color:#6b6b6b;">Period</td><td style="padding:8px 12px;font-weight:600;text-align:end;">{{period}}</td></tr>
         <tr><td style="padding:8px 12px;color:#6b6b6b;">Issue date</td><td style="padding:8px 12px;font-weight:600;text-align:end;">{{issue_date}}</td></tr>
         <tr><td style="padding:8px 12px;color:#6b6b6b;">Due date</td><td style="padding:8px 12px;font-weight:600;text-align:end;">{{due_date}}</td></tr>
       </table>
       <table style="width:100%;border-collapse:collapse;">
         <tr><td style="padding:8px 12px;color:#6b6b6b;">Subtotal</td><td style="padding:8px 12px;text-align:end;font-weight:600;">{{subtotal}}</td></tr>
         <tr><td style="padding:8px 12px;color:#6b6b6b;">Discount</td><td style="padding:8px 12px;text-align:end;font-weight:600;">{{discount}}</td></tr>
         <tr><td style="padding:8px 12px;color:#6b6b6b;">Paid</td><td style="padding:8px 12px;text-align:end;font-weight:600;">{{paid}}</td></tr>
         <tr style="border-top:2px solid #0f3d2e;"><td style="padding:12px;font-weight:800;font-size:16px;">Total due</td><td style="padding:12px;text-align:end;font-weight:800;font-size:16px;">{{total}}</td></tr>
       </table>
       <p style="color:#6b6b6b;font-size:13px;margin-top:20px;">{{footer}}</p>
$en$
where code in ('invoice-document-ar', 'invoice-document-en');

-- due-reminder (seed-only — no sender enqueues this type today)
update public.notification_templates
set
  subject_ar = 'تذكير باستحقاق {{due_date}}',
  subject_en = 'Payment due reminder for {{due_date}}',
  body_ar = $ar$
<p>عزيزي {{tenant_name}}،</p>
       <p>نذكركم باستحقاق مبلغ <strong>{{amount}}</strong> بتاريخ <strong>{{due_date}}</strong>.</p>
$ar$,
  body_en = $en$
<p>Dear {{tenant_name}},</p>
       <p>This is a reminder that <strong>{{amount}}</strong> is due on <strong>{{due_date}}</strong>.</p>
$en$
where code in ('due-reminder-ar', 'due-reminder-en');

-- user-credentials (re-assert migration 68 intro-only bodies; keep in step)
update public.notification_templates
set
  subject_ar = 'بيانات الدخول — {{display_name}}',
  subject_en = 'Login credentials — {{display_name}}',
  body_ar = $ar$
<p>مرحباً {{display_name}}،</p><p>تم إنشاء حسابك بنجاح. تجد بيانات الدخول الخاصة بك أدناه، ونوصي بتغيير كلمة المرور فور تسجيل الدخول لأول مرة.</p>
$ar$,
  body_en = $en$
<p>Hello {{display_name}},</p><p>Your account has been created. Your sign-in details are below — please change the password as soon as you first sign in.</p>
$en$
where code in ('user-credentials-ar', 'user-credentials-en');
