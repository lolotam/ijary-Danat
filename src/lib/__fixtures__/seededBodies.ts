/**
 * The bodies migration 70 seeds, mirrored here so templateFidelity.test.ts
 * checks the real text. When you change the migration, change this — the sqltest
 * checks the database, this checks the content.
 *
 * The invoice-document entry mirrors the post-201 shape: migration 201 wraps
 * the subtotal/discount rows in a {{#has_discount}} section. The pre-201 bodies
 * live in SEEDED_BODIES_PRE_201 below for the migration sqltest.
 * payment-admin-alert mirrors the post-245 shape, which adds the
 * {{payment_method}} line, inside its own section, after the payment codes.
 */
export const SEEDED_BODIES: Record<string, { ar: string; en: string }> = {
  receipt: {
    ar: `<p>شكراً لك {{tenant_name}}، تم تسجيل دفعتك بنجاح.</p>
       <ul style="padding-inline-start:20px;line-height:1.9;">
         <li><strong>المبلغ:</strong> {{amount}}</li>
         <li><strong>التاريخ:</strong> {{payment_date}}</li>
         <li><strong>المرجع:</strong> {{reference}}</li>
       </ul>`,
    en: `<p>Thank you, {{tenant_name}}. Your payment has been recorded.</p>
       <ul style="padding-inline-start:20px;line-height:1.9;">
         <li><strong>Amount:</strong> {{amount}}</li>
         <li><strong>Date:</strong> {{payment_date}}</li>
         <li><strong>Reference:</strong> {{reference}}</li>
       </ul>`,
  },
  "overdue-reminder": {
    ar: `<p>عزيزي {{tenant_name}}،</p>
       <p>لدينا رصيد متأخر على حسابك بقيمة <strong>{{outstanding}}</strong> منذ {{days_overdue}} يوماً. يرجى المبادرة بالسداد لتفادي أي إجراءات إضافية.</p>`,
    en: `<p>Dear {{tenant_name}},</p>
       <p>You have an overdue balance of <strong>{{outstanding}}</strong> that is {{days_overdue}} days past due. Please settle at your earliest convenience.</p>`,
  },
  // Re-issued by migration 73: migration 70 dropped {{unit}}, {{days_until}}
  // and {{company_name}}, which migration 58 had put here for the WhatsApp leg.
  "contract-expiry": {
    ar: `<p>مرحباً {{tenant_name}}،</p>
<p>ينتهي عقدك رقم <strong>{{contract_code}}</strong> للوحدة <strong>{{unit}}</strong> خلال <strong>{{days_until}}</strong> يوم، بتاريخ <strong>{{end_date}}</strong>.</p>
<p>يرجى التواصل معنا لمناقشة التجديد أو الإخلاء.</p>
<p>{{company_name}}</p>`,
    en: `<p>Hello {{tenant_name}},</p>
<p>Your contract <strong>{{contract_code}}</strong> for unit <strong>{{unit}}</strong> ends in <strong>{{days_until}}</strong> day(s), on <strong>{{end_date}}</strong>.</p>
<p>Please contact us to arrange renewal or handover.</p>
<p>{{company_name}}</p>`,
  },
  "deposit-confirmation": {
    ar: `<p>تم تأكيد إيداع بنكي جديد في النظام.</p>
       <ul style="padding-inline-start:20px;line-height:1.9;">
         <li><strong>المبلغ:</strong> {{amount}}</li>
         <li><strong>البنك:</strong> {{bank_name}}</li>
         <li><strong>التاريخ:</strong> {{deposit_date}}</li>
         <li><strong>الرمز:</strong> {{code}}</li>
         <li><strong>ملاحظة:</strong> {{note}}</li>
       </ul>`,
    en: `<p>A bank deposit has been confirmed in the system.</p>
       <ul style="padding-inline-start:20px;line-height:1.9;">
         <li><strong>Amount:</strong> {{amount}}</li>
         <li><strong>Bank:</strong> {{bank_name}}</li>
         <li><strong>Date:</strong> {{deposit_date}}</li>
         <li><strong>Code:</strong> {{code}}</li>
         <li><strong>Note:</strong> {{note}}</li>
       </ul>`,
  },
  "payment-admin-alert": {
    ar: `<p>قام المستأجر <strong>{{tenant_name}}</strong> بسداد مبلغ <strong>{{amount}}</strong>.</p>
       <p><strong>الفترات:</strong> {{periods}}</p>
       <p><strong>أكواد الدفع:</strong> {{payment_codes}}</p>{{#payment_method}}
       <p><strong>طريقة الدفع:</strong> {{payment_method}}</p>{{/payment_method}}`,
    en: `<p>Tenant <strong>{{tenant_name}}</strong> paid <strong>{{amount}}</strong>.</p>
       <p><strong>Periods:</strong> {{periods}}</p>
       <p><strong>Payment codes:</strong> {{payment_codes}}</p>{{#payment_method}}
       <p><strong>Payment method:</strong> {{payment_method}}</p>{{/payment_method}}`,
  },
  "invoice-document": {
    ar: `<p>مرحباً {{tenant_name}}، هذه نسخة من فاتورتك.</p>
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
          {{#has_discount}}<tr><td style="padding:8px 12px;color:#6b6b6b;">الإجمالي قبل الخصم</td><td style="padding:8px 12px;text-align:end;font-weight:600;">{{subtotal}}</td></tr>
          <tr><td style="padding:8px 12px;color:#6b6b6b;">الخصم</td><td style="padding:8px 12px;text-align:end;font-weight:600;">{{discount}}</td></tr>{{/has_discount}}
         <tr><td style="padding:8px 12px;color:#6b6b6b;">المدفوع</td><td style="padding:8px 12px;text-align:end;font-weight:600;">{{paid}}</td></tr>
         <tr style="border-top:2px solid #0f3d2e;"><td style="padding:12px;font-weight:800;font-size:16px;">الإجمالي المستحق</td><td style="padding:12px;text-align:end;font-weight:800;font-size:16px;">{{total}}</td></tr>
       </table>
       <p style="color:#6b6b6b;font-size:13px;margin-top:20px;">{{footer}}</p>`,
    en: `<p>Hello {{tenant_name}}, here is a copy of your invoice.</p>
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
          {{#has_discount}}<tr><td style="padding:8px 12px;color:#6b6b6b;">Subtotal</td><td style="padding:8px 12px;text-align:end;font-weight:600;">{{subtotal}}</td></tr>
          <tr><td style="padding:8px 12px;color:#6b6b6b;">Discount</td><td style="padding:8px 12px;text-align:end;font-weight:600;">{{discount}}</td></tr>{{/has_discount}}
         <tr><td style="padding:8px 12px;color:#6b6b6b;">Paid</td><td style="padding:8px 12px;text-align:end;font-weight:600;">{{paid}}</td></tr>
         <tr style="border-top:2px solid #0f3d2e;"><td style="padding:12px;font-weight:800;font-size:16px;">Total due</td><td style="padding:12px;text-align:end;font-weight:800;font-size:16px;">{{total}}</td></tr>
       </table>
       <p style="color:#6b6b6b;font-size:13px;margin-top:20px;">{{footer}}</p>`,
  },
  "due-reminder": {
    ar: `<p>عزيزي {{tenant_name}}،</p>
       <p>نذكركم باستحقاق مبلغ <strong>{{amount}}</strong> بتاريخ <strong>{{due_date}}</strong>.</p>`,
    en: `<p>Dear {{tenant_name}},</p>
       <p>This is a reminder that <strong>{{amount}}</strong> is due on <strong>{{due_date}}</strong>.</p>`,
  },
  "user-credentials": {
    ar: `<p>مرحباً {{display_name}}،</p><p>تم إنشاء حسابك بنجاح. تجد بيانات الدخول الخاصة بك أدناه، ونوصي بتغيير كلمة المرور فور تسجيل الدخول لأول مرة.</p>`,
    en: `<p>Hello {{display_name}},</p><p>Your account has been created. Your sign-in details are below — please change the password as soon as you first sign in.</p>`,
  },
};

/**
 * أجساد قالب نسخة الفاتورة قبل التغليف بقسم الخصم — للمقارنة في اختبار الترحيل فقط.
 *
 * The pre-201 invoice-document bodies (the seeded rows, one indentation space
 * off migration 70's file layout; the fidelity test compares rendered values,
 * not whitespace). `invoiceTemplateDiscountSection.sqltest.ts` installs these inside
 * its rollback transaction and then runs the migration file, proving the
 * wrap; the suite's global setup has already applied 201 to the live row.
 */
export const SEEDED_BODIES_PRE_201: Record<string, { ar: string; en: string }> = {
  "invoice-document": {
    ar: `<p>مرحباً {{tenant_name}}، هذه نسخة من فاتورتك.</p>
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
       <p style="color:#6b6b6b;font-size:13px;margin-top:20px;">{{footer}}</p>`,
    en: `<p>Hello {{tenant_name}}, here is a copy of your invoice.</p>
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
       <p style="color:#6b6b6b;font-size:13px;margin-top:20px;">{{footer}}</p>`,
  },
};
