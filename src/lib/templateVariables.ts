import type { NotificationType } from "@/integrations/supabase/database.types";

/**
 * One `{{placeholder}}` an admin may use, with the value the preview shows.
 *
 * Editor list and preview samples come from the same declaration on purpose:
 * defining them apart is how a preview comes to advertise a placeholder the
 * sender never supplies.
 */
export interface TemplateVariableSpec {
  key: string;
  labelAr: string;
  labelEn: string;
  sample: string;
}

const v = (key: string, labelAr: string, labelEn: string, sample: string) => ({
  key,
  labelAr,
  labelEn,
  sample,
});

/**
 * Keyed by notification type. Derived from each builder's parameters in
 * emailTemplates.ts — keep the two in step when a builder gains a field.
 *
 * Samples are invented, never real records: this renders on an admin screen and
 * must not put a real tenant's name, phone or balance there.
 */
export const TEMPLATE_VARIABLES: Partial<Record<NotificationType, TemplateVariableSpec[]>> = {
  receipt: [
    v("tenant_name", "اسم المستأجر", "Tenant name", "أحمد المطيري"),
    v("amount", "المبلغ", "Amount", "250.000 KWD"),
    v("payment_date", "تاريخ الدفع", "Payment date", "2026-08-01"),
    v("reference", "المرجع", "Reference", "PAY-2026-0042"),
  ],
  overdue_reminder: [
    v("tenant_name", "اسم المستأجر", "Tenant name", "أحمد المطيري"),
    v("outstanding", "المبلغ المستحق", "Outstanding", "500.000 KWD"),
    v("days_overdue", "أيام التأخير", "Days overdue", "12"),
  ],
  contract_expiry: [
    v("tenant_name", "اسم المستأجر", "Tenant name", "أحمد المطيري"),
    v("contract_code", "رقم العقد", "Contract code", "CTR-2025-0130"),
    v("end_date", "تاريخ الانتهاء", "End date", "2026-12-31"),
    // These three come from migration 58's WhatsApp mapping, not from the email
    // builder. The body feeds both legs — the email, and stripMarkup(body) for
    // WhatsApp — so leaving them out of this list hides them from the editor
    // while the sender still fills them.
    v("unit", "الوحدة", "Unit", "A-12 — شقة بغرفتين"),
    v("days_until", "الأيام المتبقية", "Days remaining", "9"),
    v("company_name", "اسم الشركة", "Company name", "شركة المثال العقارية"),
  ],
  document_send: [
    v("tenant_name", "اسم المستأجر", "Tenant name", "أحمد المطيري"),
    v("unit_name", "الوحدة", "Unit", "شقة 12"),
    v("property_name", "العقار", "Property", "برج المثال"),
    v("invoice_number", "رقم الفاتورة", "Invoice number", "INV-2026-0042"),
    v("period", "الفترة", "Period", "2026-08"),
    v("issue_date", "تاريخ الإصدار", "Issue date", "2026-08-01"),
    v("due_date", "تاريخ الاستحقاق", "Due date", "2026-08-10"),
    v("subtotal", "المجموع الفرعي", "Subtotal", "250.000 KWD"),
    v("discount", "الخصم", "Discount", "0.000 KWD"),
    v(
      "has_discount",
      "يوجد خصم (لأقسام {{#has_discount}})",
      "Has discount (for {{#has_discount}} sections)",
      "1",
    ),
    v("paid", "المدفوع", "Paid", "0.000 KWD"),
    v("total", "الإجمالي المستحق", "Total due", "250.000 KWD"),
    v("footer", "تذييل الفاتورة", "Invoice footer", "شكراً لتعاملكم معنا"),
  ],
  deposit_confirmation: [
    v("amount", "المبلغ", "Amount", "1,000.000 KWD"),
    v("bank_name", "البنك", "Bank", "بنك الكويت الوطني"),
    v("deposit_date", "تاريخ الإيداع", "Deposit date", "2026-08-01"),
    v("code", "رقم الإيداع", "Deposit code", "DEP-2026-0007"),
    v("note", "ملاحظة", "Note", "إيداع نقدي"),
  ],
  payment_admin_alert: [
    v("tenant_name", "اسم المستأجر", "Tenant name", "أحمد المطيري"),
    v("amount", "المبلغ", "Amount", "250.000 KWD"),
    v("periods", "الفترات", "Periods", "2026-08"),
    v("payment_codes", "أكواد الدفع", "Payment codes", "PAY-2026-0042"),
    v("payment_method", "طريقة الدفع", "Payment method", "رابط دفع (كي نت)"),
  ],
  user_credentials: [
    v("display_name", "الاسم", "Display name", "أحمد المطيري"),
    v("username", "اسم المستخدم", "Username", "ahmed"),
    v("password", "كلمة المرور", "Password", "••••••••"),
    v("email", "البريد", "Email", "ahmed@example.com"),
    v("mobile", "الجوال", "Mobile", "+965 5000 0000"),
    v("login_url", "رابط الدخول", "Login URL", "https://company.ijary.app/portal"),
  ],
  due_reminder: [
    v("tenant_name", "اسم المستأجر", "Tenant name", "أحمد المطيري"),
    v("amount", "المبلغ", "Amount", "250.000 KWD"),
    v("due_date", "تاريخ الاستحقاق", "Due date", "2026-08-10"),
  ],
  contact_inquiry: [
    v("name", "الاسم", "Name", "سارة العتيبي"),
    v("email", "البريد", "Email", "sara@example.com"),
    v("phone", "الهاتف", "Phone", "+965 5000 0000"),
    v("message", "الرسالة", "Message", "أرغب في الاستفسار عن شقة"),
  ],
  maintenance_request: [
    v("code", "رقم الطلب", "Request code", "MNT-2026-0031"),
    v("title", "العنوان", "Title", "تسريب مياه"),
    v("unit_name", "الوحدة", "Unit", "شقة 12"),
    v("priority", "الأولوية", "Priority", "عالية"),
  ],
  refund_recorded: [
    v("tenant_name", "اسم المستأجر", "Tenant name", "أحمد المطيري"),
    v("amount", "المبلغ", "Amount", "150.000 KWD"),
    v("reason", "السبب", "Reason", "إلغاء عقد"),
    v("code", "الرقم", "Code", "REF-2026-0009"),
  ],
  contract_created: [
    v("tenant_name", "اسم المستأجر", "Tenant name", "أحمد المطيري"),
    v("contract_code", "رقم العقد", "Contract code", "CTR-2026-0044"),
    v("unit_name", "الوحدة", "Unit", "شقة 12"),
    v("start_date", "تاريخ البداية", "Start date", "2026-09-01"),
    v("end_date", "تاريخ الانتهاء", "End date", "2027-08-31"),
  ],
  contract_ended: [
    v("tenant_name", "اسم المستأجر", "Tenant name", "أحمد المطيري"),
    v("contract_code", "رقم العقد", "Contract code", "CTR-2025-0130"),
    v("unit_name", "الوحدة", "Unit", "شقة 12"),
    v("end_date", "تاريخ الانتهاء", "End date", "2026-08-31"),
  ],
  contract_closeout: [
    v("tenant_name", "اسم المستأجر", "Tenant name", "أحمد المطيري"),
    v("contract_code", "رقم العقد", "Contract code", "CTR-2025-0130"),
    v("closeout_id", "معرّف الإغلاق", "Close-out id", "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
    v("outcome", "النتيجة", "Outcome", "archive"),
    v("move_out_date", "تاريخ المغادرة", "Move-out date", "2026-08-01"),
    v("refund_total", "مبلغ الاسترداد", "Refund total", "150.000 KWD"),
    v("balance_due", "المتبقي على المستأجر", "Balance due", "0.000 KWD"),
  ],
  contract_restored: [
    v("tenant_name", "اسم المستأجر", "Tenant name", "أحمد المطيري"),
    v("contract_code", "رقم العقد", "Contract code", "CTR-2025-0130"),
    v("target_state", "الحالة المستهدفة", "Target state", "terminated"),
    v("reason", "السبب", "Reason", "Tenant returning early"),
  ],
  invoice_written_off: [
    v("tenant_name", "اسم المستأجر", "Tenant name", "أحمد المطيري"),
    v("invoice_code", "رقم الفاتورة", "Invoice code", "INV-2026-0042"),
    v("amount", "المبلغ المشطوب", "Amount written off", "250.000 KWD"),
    v("reason", "السبب", "Reason", "ديون معدومة"),
    v("contract_code", "رقم العقد", "Contract code", "CTR-2025-0130"),
  ],
  company_info: [
    v("tenant_name", "اسم المستأجر", "Tenant name", "أحمد المطيري"),
    v("company_name", "اسم الشركة", "Company name", "شركة المثال العقارية"),
  ],
  invoice_disputed: [
    v("tenant_name", "اسم المستأجر", "Tenant name", "أحمد المطيري"),
    v("invoice_code", "رقم الفاتورة", "Invoice code", "INV-2026-0042"),
    v("amount", "الرصيد", "Balance", "250.000 KWD"),
    v("reason", "السبب", "Reason", "خلاف على رسوم الصيانة"),
    v("contract_code", "رقم العقد", "Contract code", "CTR-2025-0130"),
  ],
  whatsapp_session_alert: [
    v("connected_number", "الرقم المربوط", "Linked number", "+965 5000 0000"),
    v("instance_name", "اسم النسخة", "Instance name", "danat"),
    v("state", "الحالة المرصودة", "Observed state", "close"),
    v("disconnected_at", "وقت الانقطاع", "Disconnected at", "11 Nov 2026, 10:10 am"),
    v("parked_count", "الرسائل المعلّقة", "Held messages", "12"),
    v(
      "settings_url",
      "رابط إعدادات التكامل",
      "Integrations settings URL",
      "https://company.ijary.app/admin/settings/integrations",
    ),
  ],
};

/**
 * المتغيّرات المتاحة للنص الحر — اتحاد كل المُحلّلات الحيّة، بمفاتيح غير متضاربة.
 *
 * Free text has no template row and therefore no `type` to pick a variable set
 * from, so before this it could only ever bind tenant_name and company_name.
 *
 * `amount` is deliberately absent. It means the invoice balance in the
 * due-reminder resolver and the payment amount in the receipt resolver; merged
 * under one key, one of them wins invisibly and the admin cannot tell which
 * value they inserted. Templates keep `{{amount}}`, where the template's own
 * type makes it unambiguous.
 *
 * Samples are invented, never real records — this renders on an admin screen
 * and must not put a real tenant's name or balance there.
 */
export const FREE_TEXT_VARIABLES: TemplateVariableSpec[] = [
  v("tenant_name", "اسم المستأجر", "Tenant name", "أحمد المطيري"),
  v("company_name", "اسم الشركة", "Company name", "شركة المثال العقارية"),
  v("invoice_amount", "مبلغ الفاتورة", "Invoice amount", "250.000 KWD"),
  v("due_date", "تاريخ الاستحقاق", "Due date", "2026-08-10"),
  v("outstanding", "المبلغ المستحق", "Outstanding", "500.000 KWD"),
  v("days_overdue", "أيام التأخير", "Days overdue", "12"),
  v("payment_amount", "مبلغ الدفعة", "Payment amount", "250.000 KWD"),
  v("payment_date", "تاريخ الدفع", "Payment date", "2026-08-01"),
  v("reference", "المرجع", "Reference", "PAY-2026-0042"),
  v("contract_code", "رقم العقد", "Contract code", "CTR-2025-0130"),
  v("end_date", "تاريخ انتهاء العقد", "Contract end date", "2026-12-31"),
  v("unit", "الوحدة", "Unit", "A-12 — شقة بغرفتين"),
  v("days_until", "الأيام المتبقية", "Days remaining", "9"),
  v("pay_now_url", "رابط الدفع", "Payment link", "https://company.ijary.app/portal/invoices"),
];

/** The preview's substitution map for one type. */
export function sampleVariablesFor(type: NotificationType): Record<string, string> {
  return Object.fromEntries((TEMPLATE_VARIABLES[type] ?? []).map((s) => [s.key, s.sample]));
}
