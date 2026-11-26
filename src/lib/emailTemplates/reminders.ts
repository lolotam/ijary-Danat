import { escapeHtml } from "@/lib/html";
import { wrapLayout, type EmailLocale, type TemplateResult } from "./layout";

/**
 * رسائل التذكير: الرصيد المتأخر مع زر الدفع، وتنبيه انتهاء العقد.
 */

/**
 * Deep link to the tenant portal's invoices tab.
 *
 * Absolute because it is read outside the app — an email client or WhatsApp has
 * no origin to resolve a relative path against. A logged-out tenant following it
 * is bounced to `/portal/auth?redirect=/portal/invoices` by the portal layout
 * guard and lands back here after signing in; the auth route only honours a
 * redirect beginning with `/portal`, so this cannot be turned into an open
 * redirect. `companyOrigin` is the renter's own company address (see
 * `src/company/companyUrl.server.ts`): each company's portal lives on its own host.
 */
export function portalInvoicesUrl(companyOrigin: string): string {
  return `${companyOrigin.replace(/\/$/, "")}/portal/invoices`;
}

/**
 * A "Pay Now" button, table-wrapped with inline styles.
 *
 * Outlook renders a padded <a> as an unpadded text link, and every mail client
 * strips <style> blocks, so the button has to be a single-cell table carrying
 * its own colours. The href is repeated as plain text underneath because some
 * clients strip the anchor entirely from a forwarded message.
 */
function payNowButton(locale: EmailLocale, url: string): string {
  const isAr = locale === "ar";
  const label = isAr ? "ادفع الآن" : "Pay Now";
  return `
       <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
         <tr>
           <td align="center" bgcolor="#0f766e" style="border-radius:6px;">
             <a href="${escapeHtml(url)}"
                style="display:inline-block;padding:12px 28px;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:6px;">
               ${label}
             </a>
           </td>
         </tr>
       </table>`;
}

export function overdueReminderTemplate(params: {
  locale: EmailLocale;
  tenantName: string;
  outstanding: string;
  daysOverdue: number;
  payNowUrl: string;
}): TemplateResult {
  const { locale, tenantName, outstanding, daysOverdue, payNowUrl } = params;
  const isAr = locale === "ar";
  const subject = isAr
    ? `تذكير بمبالغ متأخرة (${daysOverdue} يوم)`
    : `Overdue balance reminder (${daysOverdue} days)`;
  const title = isAr ? "تذكير بالسداد" : "Payment Reminder";
  const body = isAr
    ? `<p>عزيزي ${escapeHtml(tenantName)}،</p>
       <p>لدينا رصيد متأخر على حسابك بقيمة <strong>${escapeHtml(outstanding)}</strong> منذ ${daysOverdue} يوماً. يرجى المبادرة بالسداد لتفادي أي إجراءات إضافية.</p>${payNowButton(locale, payNowUrl)}
       <p style="font-size:12px;color:#64748b;">إذا لم يعمل الزر، افتح هذا الرابط: ${escapeHtml(payNowUrl)}</p>`
    : `<p>Dear ${escapeHtml(tenantName)},</p>
       <p>You have an overdue balance of <strong>${escapeHtml(outstanding)}</strong> that is ${daysOverdue} days past due. Please settle at your earliest convenience.</p>${payNowButton(locale, payNowUrl)}
       <p style="font-size:12px;color:#64748b;">If the button does not work, open this link: ${escapeHtml(payNowUrl)}</p>`;
  // WhatsApp reads this, and stripMarkup would delete an anchor — so the URL is
  // bare text here, not markup.
  const text = isAr
    ? `رصيد متأخر ${outstanding} منذ ${daysOverdue} يوم.\nادفع الآن: ${payNowUrl}`
    : `Overdue balance ${outstanding} — ${daysOverdue} days.\nPay Now: ${payNowUrl}`;
  return { subject, html: wrapLayout(locale, title, body), text };
}

export function contractExpiryTemplate(params: {
  locale: EmailLocale;
  tenantName: string;
  contractCode: string;
  endDate: string;
}): TemplateResult {
  const { locale, tenantName, contractCode, endDate } = params;
  const isAr = locale === "ar";
  const subject = isAr
    ? `تنبيه انتهاء العقد ${contractCode}`
    : `Contract ${contractCode} expiry notice`;
  const title = isAr ? "تنبيه انتهاء العقد" : "Contract Expiry";
  const body = isAr
    ? `<p>مرحباً ${escapeHtml(tenantName)}،</p>
       <p>ينتهي عقدك رقم <strong>${escapeHtml(contractCode)}</strong> بتاريخ <strong>${escapeHtml(endDate)}</strong>. يرجى التواصل معنا لمناقشة التجديد أو الإخلاء.</p>`
    : `<p>Hello ${escapeHtml(tenantName)},</p>
       <p>Your contract <strong>${escapeHtml(contractCode)}</strong> is scheduled to end on <strong>${escapeHtml(endDate)}</strong>. Please contact us to arrange renewal or handover.</p>`;
  const text = isAr
    ? `عقد ${contractCode} ينتهي بتاريخ ${endDate}.`
    : `Contract ${contractCode} ends on ${endDate}.`;
  return { subject, html: wrapLayout(locale, title, body), text };
}
