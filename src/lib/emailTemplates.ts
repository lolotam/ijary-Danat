/**
 * Branded HTML email templates for IJARY companies.
 *
 * All templates are Arabic-first (RTL) with English fallback. They use
 * inline styles for maximum client compatibility (Gmail, Outlook, Apple Mail).
 * The header carries the platform name until the send path substitutes the
 * sending company's own name and logo (`applyEmailLogo`).
 */

// The builders live in ./emailTemplates/, one file per message family; this
// module keeps the `@/lib/emailTemplates` import path and the registry.

import { escapeHtml } from "@/lib/html";

import { tenantCredentialsTemplate, welcomeManagerialTemplate } from "./emailTemplates/credentials";
import { invoiceDocumentTemplate, invoiceIssuedTemplate } from "./emailTemplates/invoices";
import {
  depositConfirmationTemplate,
  paymentAdminAlertTemplate,
  paymentReceiptTemplate,
} from "./emailTemplates/payments";
import { contractExpiryTemplate, overdueReminderTemplate } from "./emailTemplates/reminders";
import {
  BRAND,
  button,
  wrapLayout,
  type EmailLocale,
  type TemplateResult,
} from "./emailTemplates/layout";

export {
  applyEmailBrandName,
  EMAIL_BRAND_NAME_CLOSE,
  EMAIL_BRAND_NAME_OPEN,
  EMAIL_LOGO_MARKER,
  emailBrandName,
  renderEmailDocument,
  type EmailLocale,
} from "./emailTemplates/layout";
export {
  tenantCredentialsTemplate,
  welcomeManagerialTemplate,
  type CredentialFields,
} from "./emailTemplates/credentials";
export { invoiceDocumentTemplate, invoiceIssuedTemplate } from "./emailTemplates/invoices";
export {
  depositConfirmationTemplate,
  paymentAdminAlertTemplate,
  paymentReceiptTemplate,
} from "./emailTemplates/payments";
export {
  contractExpiryTemplate,
  overdueReminderTemplate,
  portalInvoicesUrl,
} from "./emailTemplates/reminders";

export const EMAIL_TEMPLATE_REGISTRY = {
  tenant_credentials: tenantCredentialsTemplate,
  invoice_issued: invoiceIssuedTemplate,
  invoice_document: invoiceDocumentTemplate,
  payment_receipt: paymentReceiptTemplate,
  overdue_reminder: overdueReminderTemplate,
  contract_expiry: contractExpiryTemplate,
  welcome_managerial: welcomeManagerialTemplate,
  deposit_confirmation: depositConfirmationTemplate,
  payment_admin_alert: paymentAdminAlertTemplate,
  password_reset: passwordResetTemplate,
} as const;

export type EmailTemplateKey = keyof typeof EMAIL_TEMPLATE_REGISTRY;

/**
 * رسالة إعادة تعيين كلمة المرور: رابط واحد صالح لمرة واحدة.
 *
 * The link carries the raw token, so this body is the one place the token
 * leaves the system — it must never be stored anywhere else (the database
 * keeps only its SHA-256 digest).
 *
 * `intro` and `subject` come from the company's own `notification_templates`
 * row, so an admin can rewrite the wording; the branded shell, the button and
 * the expiry note stay under code's control, because a template body that
 * dropped the link would leave the recipient with nothing to click.
 */
export function passwordResetTemplate(params: {
  locale: EmailLocale;
  displayName?: string | null;
  resetUrl: string;
  /** Minutes the link stays valid — stated in the message so nobody waits for a dead link. */
  expiresMinutes: number;
  intro?: string | null;
  subject?: string | null;
}): TemplateResult {
  const { locale, displayName, resetUrl, expiresMinutes, intro, subject } = params;
  const isAr = locale === "ar";
  const fallbackSubject = isAr ? "إعادة تعيين كلمة المرور" : "Reset your password";
  const title = isAr ? "إعادة تعيين كلمة المرور" : "Password reset";
  const name = displayName?.trim();
  const opening =
    intro?.trim() ||
    (isAr
      ? `<p>${name ? `مرحباً ${escapeHtml(name)}،` : "مرحباً،"}</p>
       <p>وصلنا طلب لإعادة تعيين كلمة المرور الخاصة بحسابك.</p>`
      : `<p>${name ? `Hello ${escapeHtml(name)},` : "Hello,"}</p>
       <p>We received a request to reset the password of your account.</p>`);
  const body = isAr
    ? `${opening}
       ${button(locale, resetUrl, "إعادة تعيين كلمة المرور")}
       <p>ينتهي صلاحية هذا الرابط خلال ${expiresMinutes} دقيقة، ويمكن استخدامه مرة واحدة فقط.</p>
       <p style="color:${BRAND.muted};font-size:13px;">إذا لم تطلب إعادة تعيين كلمة المرور، تجاهل هذه الرسالة وستبقى كلمة مرورك كما هي.</p>`
    : `${opening}
       ${button(locale, resetUrl, "Reset password")}
       <p>This link is valid for ${expiresMinutes} minutes and can be used once.</p>
       <p style="color:${BRAND.muted};font-size:13px;">If you did not request a password reset, ignore this message and your password will stay as it is.</p>`;
  const text = isAr
    ? `إعادة تعيين كلمة المرور: ${resetUrl} (تنتهي خلال ${expiresMinutes} دقيقة)`
    : `Reset your password: ${resetUrl} (valid for ${expiresMinutes} minutes)`;
  return {
    subject: subject?.trim() || fallbackSubject,
    html: wrapLayout(locale, title, body),
    text,
  };
}
