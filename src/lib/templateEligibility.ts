import { WORKFLOW_CATALOG } from "@/lib/workflowCatalog";
import type { NotificationType } from "@/integrations/supabase/database.types";

export type TenantEligibility =
  | { mode: "always" }
  | { mode: "never" }
  | { mode: "viaWorkflows"; keys: string[] };

/**
 * البوابة الأولى: هل يجوز أن يصل هذا النوع إلى المستأجر أصلًا؟
 *
 * `never` is not the same as an empty key list. `payment-succeeded` carries the
 * `tenant` pill on behalf of its sibling `receipt` template, so deriving
 * payment_admin_alert's audience from its workflow would leak a staff-only alert
 * into the tenant dropdown. `manual-payment-invoice` splits the same way.
 */
export const TEMPLATE_TENANT_ELIGIBILITY: Record<NotificationType, TenantEligibility> = {
  due_reminder: { mode: "always" },
  manual_message: { mode: "always" },
  company_info: { mode: "always" },
  document_send: { mode: "always" },
  payment_admin_alert: { mode: "never" },
  scheduled_report: { mode: "never" },
  overdue_reminder: { mode: "viaWorkflows", keys: ["overdue-reminders"] },
  receipt: { mode: "viaWorkflows", keys: ["payment-succeeded", "manual-payment-invoice"] },
  contract_expiry: { mode: "viaWorkflows", keys: ["contract-expiry"] },
  user_credentials: {
    mode: "viaWorkflows",
    keys: ["user-credentials-tenant", "user-credentials-managerial"],
  },
  deposit_confirmation: { mode: "viaWorkflows", keys: ["deposit-confirmed"] },
  contact_inquiry: { mode: "viaWorkflows", keys: ["contact-inquiry-received"] },
  maintenance_request: { mode: "viaWorkflows", keys: ["maintenance-request-created"] },
  refund_recorded: { mode: "viaWorkflows", keys: ["refund-recorded"] },
  contract_created: { mode: "viaWorkflows", keys: ["contract-created"] },
  contract_ended: { mode: "viaWorkflows", keys: ["contract-ended"] },
  contract_closeout: { mode: "viaWorkflows", keys: ["contract-closeout-completed"] },
  contract_restored: { mode: "viaWorkflows", keys: ["contract-restored"] },
  invoice_written_off: { mode: "viaWorkflows", keys: ["invoice-written-off"] },
  invoice_disputed: { mode: "viaWorkflows", keys: ["invoice-disputed"] },
  whatsapp_session_alert: { mode: "never" },
};

/**
 * البوابة الثانية: هل يستطيع مسار الإرسال اليدوي العام تكوين هذه الرسالة فعلًا؟
 *
 * Exactly the types `resolveTypeVariables` resolves — nothing else has a
 * resolver, so every other type renders its placeholders empty.
 *
 * `manual_message` is NOT here: free text is the `templateCode === null` branch,
 * which picks resolvers from the placeholders present. A stored manual_message
 * row takes the template branch and gets `{}`. Free text is unaffected — both
 * dialogs keep their separate "free" option.
 *
 * `company_info` is NOT here either: it is a dedicated single-recipient action
 * with its own server fn, and the bulk dialog has no special case for it, so a
 * shared set would make it bulk-selectable and send stored copy with neither the
 * generated body nor the PDF.
 */
export const MANUALLY_RENDERABLE_TYPES: ReadonlySet<NotificationType> = new Set([
  "overdue_reminder",
  "due_reminder",
  "receipt",
  "contract_expiry",
]);

/**
 * يقرّر ما إذا كان القالب معروضًا للإرسال اليدوي، بتطبيق البوابتين معًا.
 *
 * Shared by the dialogs and by sendNotification/sendBulkNotification. A filtered
 * dropdown is presentation; the server functions are the control.
 */
export function isTemplateOfferable(
  type: NotificationType,
  workflows: ReadonlyArray<{ key: string; recipient_targets: string[] | null }>,
): boolean {
  if (!MANUALLY_RENDERABLE_TYPES.has(type)) return false;
  const audience = TEMPLATE_TENANT_ELIGIBILITY[type];
  if (audience.mode === "never") return false;
  if (audience.mode === "always") return true;
  return audience.keys.some((key) => {
    if (!Object.prototype.hasOwnProperty.call(WORKFLOW_CATALOG, key)) return false;
    const row = workflows.find((w) => w.key === key);
    return (row?.recipient_targets ?? []).includes("tenant");
  });
}
