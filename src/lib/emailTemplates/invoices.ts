import { escapeHtml } from "@/lib/html";
import { BRAND, button, wrapLayout, type EmailLocale, type TemplateResult } from "./layout";

/**
 * رسائل الفواتير: إشعار فاتورة جديدة ونسخة الفاتورة الكاملة.
 */

export function invoiceIssuedTemplate(params: {
  locale: EmailLocale;
  tenantName: string;
  invoiceNumber: string;
  amount: string;
  dueDate: string;
  payUrl?: string;
}): TemplateResult {
  const { locale, tenantName, invoiceNumber, amount, dueDate, payUrl } = params;
  const isAr = locale === "ar";
  const subject = isAr ? `فاتورة جديدة #${invoiceNumber}` : `New invoice #${invoiceNumber}`;
  const title = isAr ? "فاتورة جديدة" : "New Invoice";
  const rows = isAr
    ? [
        ["رقم الفاتورة", invoiceNumber],
        ["المبلغ", amount],
        ["تاريخ الاستحقاق", dueDate],
      ]
    : [
        ["Invoice", invoiceNumber],
        ["Amount", amount],
        ["Due date", dueDate],
      ];
  const rowsHtml = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:8px 12px;color:${BRAND.muted};">${escapeHtml(k)}</td><td style="padding:8px 12px;font-weight:600;">${escapeHtml(v)}</td></tr>`,
    )
    .join("");
  const body = isAr
    ? `<p>مرحباً ${escapeHtml(tenantName)}،</p>
       <p>تم إصدار فاتورة جديدة على حسابك:</p>
       <table style="width:100%;border-collapse:collapse;background:${BRAND.bg};border-radius:8px;overflow:hidden;">${rowsHtml}</table>
       ${payUrl ? button(locale, payUrl, "دفع الآن") : ""}`
    : `<p>Hello ${escapeHtml(tenantName)},</p>
       <p>A new invoice has been issued on your account:</p>
       <table style="width:100%;border-collapse:collapse;background:${BRAND.bg};border-radius:8px;overflow:hidden;">${rowsHtml}</table>
       ${payUrl ? button(locale, payUrl, "Pay now") : ""}`;
  const text = isAr
    ? `فاتورة ${invoiceNumber} — ${amount} — استحقاق ${dueDate}`
    : `Invoice ${invoiceNumber} — ${amount} — due ${dueDate}`;
  return { subject, html: wrapLayout(locale, title, body), text };
}

/**
 * النسخة المدمجة من بريد «فاتورة»: تفاصيل الفاتورة ثم ملخّص المبالغ.
 *
 * `discount` is `string | null`: null means the invoice carries no discount,
 * and both the "before discount" and the discount rows are withheld — a
 * subtotal that equals the total with a 0 under it reads as a discount someone
 * forgot to apply.
 */
export function invoiceDocumentTemplate(params: {
  locale: EmailLocale;
  tenantName: string;
  unitName: string;
  propertyName: string;
  invoiceNumber: string;
  period: string;
  issueDate: string;
  dueDate: string;
  subtotal: string;
  discount: string | null;
  paid: string;
  total: string;
  footer?: string | null;
  payUrl?: string;
}): TemplateResult {
  const {
    locale,
    tenantName,
    unitName,
    propertyName,
    invoiceNumber,
    period,
    issueDate,
    dueDate,
    subtotal,
    discount,
    paid,
    total,
    footer,
    payUrl,
  } = params;
  const isAr = locale === "ar";
  const subject = isAr ? `فاتورتك #${invoiceNumber}` : `Your invoice #${invoiceNumber}`;
  const title = isAr ? "فاتورة" : "Invoice";
  // Two detail blocks mirror the printable InvoicePrint sheet: the party/period
  // rows, then the money summary.
  const info: Array<[string, string]> = isAr
    ? [
        ["رقم الفاتورة", invoiceNumber],
        ["المستثمر", tenantName],
        ["الوحدة", unitName],
        ["العقار", propertyName],
        ["الفترة", period],
        ["تاريخ الإصدار", issueDate],
        ["تاريخ الاستحقاق", dueDate],
      ]
    : [
        ["Invoice", invoiceNumber],
        ["Investor", tenantName],
        ["Unit", unitName],
        ["Property", propertyName],
        ["Period", period],
        ["Issue date", issueDate],
        ["Due date", dueDate],
      ];
  const totals: Array<[string, string, boolean]> = [
    ...(discount != null
      ? ([
          [isAr ? "الإجمالي قبل الخصم" : "Subtotal", subtotal, false],
          [isAr ? "الخصم" : "Discount", discount, false],
        ] as Array<[string, string, boolean]>)
      : []),
    [isAr ? "المدفوع" : "Paid", paid, false],
    [isAr ? "الإجمالي المستحق" : "Total due", total, true],
  ];
  const infoHtml = info
    .map(
      ([k, v]) =>
        `<tr><td style="padding:8px 12px;color:${BRAND.muted};">${escapeHtml(k)}</td><td style="padding:8px 12px;font-weight:600;text-align:end;">${escapeHtml(v)}</td></tr>`,
    )
    .join("");
  const totalsHtml = totals
    .map(
      ([k, v, strong]) =>
        `<tr style="${strong ? `border-top:2px solid ${BRAND.primary};` : ""}"><td style="padding:${strong ? "12px" : "8px 12px"};${strong ? "font-weight:800;font-size:16px;" : `color:${BRAND.muted};`}">${escapeHtml(k)}</td><td style="padding:${strong ? "12px" : "8px 12px"};text-align:end;${strong ? "font-weight:800;font-size:16px;" : "font-weight:600;"}">${escapeHtml(v)}</td></tr>`,
    )
    .join("");
  const intro = isAr
    ? `<p>مرحباً ${escapeHtml(tenantName)}، هذه نسخة من فاتورتك.</p>`
    : `<p>Hello ${escapeHtml(tenantName)}, here is a copy of your invoice.</p>`;
  const footerHtml = footer
    ? `<p style="color:${BRAND.muted};font-size:13px;margin-top:20px;">${escapeHtml(footer)}</p>`
    : "";
  const body = `${intro}
       <table style="width:100%;border-collapse:collapse;background:${BRAND.bg};border-radius:8px;overflow:hidden;margin-bottom:16px;">${infoHtml}</table>
       <table style="width:100%;border-collapse:collapse;">${totalsHtml}</table>
       ${payUrl ? button(locale, payUrl, isAr ? "عرض في البوابة" : "View in portal") : ""}
       ${footerHtml}`;
  const text = isAr
    ? `فاتورة ${invoiceNumber} — الفترة ${period} — الإجمالي المستحق ${total} — استحقاق ${dueDate}`
    : `Invoice ${invoiceNumber} — period ${period} — total due ${total} — due ${dueDate}`;
  return { subject, html: wrapLayout(locale, title, body), text };
}
