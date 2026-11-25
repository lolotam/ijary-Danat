/**
 * Branded HTML email templates for Danat Al Mustaqbal Real Estate.
 *
 * All templates are Arabic-first (RTL) with English fallback. They use
 * inline styles for maximum client compatibility (Gmail, Outlook, Apple Mail).
 */

// The builders live in ./emailTemplates/, one file per message family; this
// module keeps the `@/lib/emailTemplates` import path and the registry.

import { tenantCredentialsTemplate, welcomeManagerialTemplate } from "./emailTemplates/credentials";
import { invoiceDocumentTemplate, invoiceIssuedTemplate } from "./emailTemplates/invoices";
import {
  depositConfirmationTemplate,
  paymentAdminAlertTemplate,
  paymentReceiptTemplate,
} from "./emailTemplates/payments";
import { contractExpiryTemplate, overdueReminderTemplate } from "./emailTemplates/reminders";

export {
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
} as const;

export type EmailTemplateKey = keyof typeof EMAIL_TEMPLATE_REGISTRY;
