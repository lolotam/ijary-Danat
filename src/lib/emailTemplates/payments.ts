import { escapeHtml } from "@/lib/html";
import { wrapLayout, type EmailLocale, type TemplateResult } from "./layout";

/**
 * رسائل المدفوعات: إيصال المستأجر، تأكيد الإيداع البنكي، وتنبيه الإدارة بالدفعة.
 */

/**
 * One `<li>` naming why an invoice was settled by hand, or nothing at all.
 *
 * Returning an empty string for the gateway case is what keeps a card receipt
 * byte-identical to what it was before migration 108 — a tenant who paid online
 * has no manual reason, and a row reading "Reason: —" would invite the question
 * of what went wrong when nothing did.
 */
function manualReasonListItem(locale: EmailLocale, manualPaymentReason?: string | null): string {
  if (!manualPaymentReason) return "";
  const label = locale === "ar" ? "سبب الدفع اليدوي" : "Reason of manual payment";
  return `\n         <li><strong>${label}:</strong> ${escapeHtml(manualPaymentReason)}</li>`;
}

export function paymentReceiptTemplate(params: {
  locale: EmailLocale;
  tenantName: string;
  amount: string;
  paymentDate: string;
  reference: string;
  manualPaymentReason?: string | null;
}): TemplateResult {
  const { locale, tenantName, amount, paymentDate, reference, manualPaymentReason } = params;
  const isAr = locale === "ar";
  const subject = isAr ? `إيصال دفع — ${reference}` : `Payment receipt — ${reference}`;
  const title = isAr ? "إيصال دفع" : "Payment Receipt";
  const reasonItem = manualReasonListItem(locale, manualPaymentReason);
  const body = isAr
    ? `<p>شكراً لك ${escapeHtml(tenantName)}، تم تسجيل دفعتك بنجاح.</p>
       <ul style="padding-inline-start:20px;line-height:1.9;">
         <li><strong>المبلغ:</strong> ${escapeHtml(amount)}</li>
         <li><strong>التاريخ:</strong> ${escapeHtml(paymentDate)}</li>
         <li><strong>المرجع:</strong> ${escapeHtml(reference)}</li>${reasonItem}
       </ul>`
    : `<p>Thank you, ${escapeHtml(tenantName)}. Your payment has been recorded.</p>
       <ul style="padding-inline-start:20px;line-height:1.9;">
         <li><strong>Amount:</strong> ${escapeHtml(amount)}</li>
         <li><strong>Date:</strong> ${escapeHtml(paymentDate)}</li>
         <li><strong>Reference:</strong> ${escapeHtml(reference)}</li>${reasonItem}
       </ul>`;
  const reasonText = manualPaymentReason
    ? isAr
      ? ` سبب الدفع اليدوي: ${manualPaymentReason}.`
      : ` Reason of manual payment: ${manualPaymentReason}.`
    : "";
  const text = isAr
    ? `تم استلام ${amount} في ${paymentDate}. المرجع ${reference}.${reasonText}`
    : `Received ${amount} on ${paymentDate}. Reference ${reference}.${reasonText}`;
  return { subject, html: wrapLayout(locale, title, body), text };
}

export function depositConfirmationTemplate(params: {
  locale: EmailLocale;
  amount: string;
  bankName: string;
  depositDate: string;
  code: string;
  note?: string | null;
}): TemplateResult {
  const { locale, amount, bankName, depositDate, code, note } = params;
  const isAr = locale === "ar";
  const subject = isAr ? `تأكيد إيداع بنكي — ${code}` : `Bank deposit confirmed — ${code}`;
  const title = isAr ? "تأكيد إيداع بنكي" : "Bank Deposit Confirmed";
  const body = isAr
    ? `<p>تم تأكيد إيداع بنكي جديد في النظام.</p>
       <ul style="padding-inline-start:20px;line-height:1.9;">
         <li><strong>المبلغ:</strong> ${escapeHtml(amount)}</li>
         <li><strong>البنك:</strong> ${escapeHtml(bankName)}</li>
         <li><strong>التاريخ:</strong> ${escapeHtml(depositDate)}</li>
         <li><strong>الرمز:</strong> ${escapeHtml(code)}</li>
         ${note ? `<li><strong>ملاحظة:</strong> ${escapeHtml(note)}</li>` : ""}
       </ul>`
    : `<p>A bank deposit has been confirmed in the system.</p>
       <ul style="padding-inline-start:20px;line-height:1.9;">
         <li><strong>Amount:</strong> ${escapeHtml(amount)}</li>
         <li><strong>Bank:</strong> ${escapeHtml(bankName)}</li>
         <li><strong>Date:</strong> ${escapeHtml(depositDate)}</li>
         <li><strong>Code:</strong> ${escapeHtml(code)}</li>
         ${note ? `<li><strong>Note:</strong> ${escapeHtml(note)}</li>` : ""}
       </ul>`;
  const textBody = isAr
    ? `إيداع ${amount} — ${bankName} — ${depositDate} — ${code}`
    : `Deposit ${amount} — ${bankName} — ${depositDate} — ${code}`;
  return { subject, html: wrapLayout(locale, title, body), text: textBody };
}

/**
 * يبني تنبيه الإدارة بدفعة مستأجر: المبلغ والفترات وأكواد الدفع وطريقة الدفع.
 *
 * The built-in fallback for the `payment-admin-alert` template row; the method
 * line is omitted when no method is known rather than printing a dash.
 */
export function paymentAdminAlertTemplate(params: {
  locale: EmailLocale;
  tenantName: string;
  amount: string;
  periods: string;
  paymentCodes: string;
  paymentMethod?: string | null;
  manualPaymentReason?: string | null;
}): TemplateResult {
  const { locale, tenantName, amount, periods, paymentCodes, paymentMethod, manualPaymentReason } =
    params;
  const isAr = locale === "ar";
  const subject = isAr ? `دفعة مستأجر — ${tenantName}` : `Tenant payment — ${tenantName}`;
  const title = isAr ? "تنبيه دفعة مستأجر" : "Tenant Payment Alert";
  const reasonParagraph = manualPaymentReason
    ? isAr
      ? `\n       <p><strong>سبب الدفع اليدوي:</strong> ${escapeHtml(manualPaymentReason)}</p>`
      : `\n       <p><strong>Reason of manual payment:</strong> ${escapeHtml(manualPaymentReason)}</p>`
    : "";
  const methodParagraph = paymentMethod
    ? isAr
      ? `\n       <p><strong>طريقة الدفع:</strong> ${escapeHtml(paymentMethod)}</p>`
      : `\n       <p><strong>Payment method:</strong> ${escapeHtml(paymentMethod)}</p>`
    : "";
  const body = isAr
    ? `<p>قام المستأجر <strong>${escapeHtml(tenantName)}</strong> بسداد مبلغ <strong>${escapeHtml(amount)}</strong>.</p>
       <p><strong>الفترات:</strong> ${escapeHtml(periods)}</p>
       <p><strong>أكواد الدفع:</strong> ${escapeHtml(paymentCodes)}</p>${methodParagraph}${reasonParagraph}`
    : `<p>Tenant <strong>${escapeHtml(tenantName)}</strong> paid <strong>${escapeHtml(amount)}</strong>.</p>
       <p><strong>Periods:</strong> ${escapeHtml(periods)}</p>
       <p><strong>Payment codes:</strong> ${escapeHtml(paymentCodes)}</p>${methodParagraph}${reasonParagraph}`;
  const reasonText = manualPaymentReason
    ? isAr
      ? ` — سبب الدفع اليدوي: ${manualPaymentReason}`
      : ` — reason of manual payment: ${manualPaymentReason}`
    : "";
  const methodText = paymentMethod ? ` — ${paymentMethod}` : "";
  const textBody = isAr
    ? `${tenantName} دفع ${amount} عن ${periods}${methodText}${reasonText}`
    : `${tenantName} paid ${amount} for ${periods}${methodText}${reasonText}`;
  return { subject, html: wrapLayout(locale, title, body), text: textBody };
}
