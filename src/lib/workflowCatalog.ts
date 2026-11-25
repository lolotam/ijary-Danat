import type { PermissionCode } from "@/lib/permissions";
import type { WorkflowRecipientTarget } from "@/integrations/supabase/database.types";

export type { WorkflowRecipientTarget };

export type WorkflowCatalogEntry = {
  kind: "scheduled" | "event";
  /** Send blocks this workflow actually has — UI disables unsupported pills. */
  supportedTargets: WorkflowRecipientTarget[];
  /** Scheduled only — permission required for admin run-now. */
  runPermission?: PermissionCode;
  /** Scheduled only — documents the deployed host crontab; not used for dispatch. */
  schedule?: string;
};

/**
 * Single source of truth for built-in workflows. Inserting a cron_jobs row does
 * not wire a dispatcher — only keys present here (and in JOBS / a sender) run.
 *
 * `schedule` mirrors deploy/README.md crontab lines; change both together.
 */
export const WORKFLOW_CATALOG: Record<string, WorkflowCatalogEntry> = {
  // --- scheduled (JOBS map in src/fns/cronJobs.ts) ---
  overdue: {
    kind: "scheduled",
    supportedTargets: ["admin", "company"],
    runPermission: "invoices.update",
    schedule: "10 1 * * *",
  },
  "overdue-reminders": {
    kind: "scheduled",
    supportedTargets: ["tenant"],
    runPermission: "notifications.send",
    schedule: "15 1 * * *",
  },
  "contract-expiry": {
    kind: "scheduled",
    supportedTargets: ["admin", "company", "tenant"],
    runPermission: "notifications.create",
    schedule: "20 1 * * *",
  },
  "scheduled-reports": {
    kind: "scheduled",
    supportedTargets: ["admin", "company"],
    runPermission: "reports.read",
    schedule: "30 1 * * *",
  },
  "notification-drain": {
    kind: "scheduled",
    supportedTargets: ["admin", "company"],
    runPermission: "notifications.send",
    schedule: "40 1 * * *",
  },
  "gmail-sync": {
    kind: "scheduled",
    supportedTargets: ["admin", "company"],
    runPermission: "notifications.read",
    // Every 10 minutes — inbox-facing; change host crontab in deploy/README.md together.
    schedule: "*/10 * * * *",
  },
  salaries: {
    kind: "scheduled",
    supportedTargets: ["admin", "company"],
    runPermission: "salaries.create",
    schedule: "30 1 1 * *",
  },
  "payment-reconcile": {
    kind: "scheduled",
    supportedTargets: ["admin", "company"],
    runPermission: "payments.create",
    // Every 10 minutes at :05, staggered off gmail-sync's :00. A tenant who paid
    // a link should not wait an hour for the invoice to catch up.
    schedule: "5-59/10 * * * *",
  },
  backup: {
    kind: "scheduled",
    supportedTargets: ["admin"],
    // Writes a full copy of the database — secrets included — to storage, so
    // it needs the dedicated backup permission, not a general one like
    // company.update (migration 230).
    runPermission: "settings.backup",
    schedule: "50 1 * * *",
  },
  "log-retention": {
    kind: "scheduled",
    // Sends nothing — it only deletes old log rows.
    supportedTargets: [],
    // Running it can shorten the audit trail, so it takes the same
    // admin-level right as the backup it runs after.
    runPermission: "settings.backup",
    schedule: "0 2 * * *",
  },

  // --- event (hardcoded into a sender via runEventWorkflow) ---
  "contact-inquiry-received": {
    kind: "event",
    supportedTargets: ["admin", "company"],
  },
  "contract-created": {
    kind: "event",
    supportedTargets: ["admin", "company"],
  },
  "contract-ended": {
    kind: "event",
    supportedTargets: ["admin", "company"],
  },
  "deposit-confirmed": {
    kind: "event",
    supportedTargets: ["admin", "company"],
  },
  "maintenance-request-created": {
    kind: "event",
    supportedTargets: ["admin", "company"],
  },
  // Fires when an admin ticks an invoice paid on /admin/invoices, which records
  // a cash payment for the remaining balance. Separate from `payment-succeeded`
  // so the reconciliation receipt can be switched off — or aimed only at staff —
  // without silencing the receipt a tenant gets for their own card payment.
  "manual-payment-invoice": {
    kind: "event",
    supportedTargets: ["admin", "company", "tenant"],
  },
  "payment-succeeded": {
    kind: "event",
    supportedTargets: ["admin", "company", "tenant"],
  },
  "refund-recorded": {
    kind: "event",
    supportedTargets: ["admin", "company"],
  },
  // Close-out and restore are internal operational notices (email only).
  "contract-closeout-completed": {
    kind: "event",
    supportedTargets: ["admin", "company"],
  },
  "contract-restored": {
    kind: "event",
    supportedTargets: ["admin", "company"],
  },
  // Write-off and dispute: money stops being expected. Email-only (migration 93).
  "invoice-written-off": {
    kind: "event",
    supportedTargets: ["admin", "company"],
  },
  "invoice-disputed": {
    kind: "event",
    supportedTargets: ["admin", "company"],
  },
  // The new staff user's own credential mail always sends — it is account
  // provisioning, not a preference — and a staff user is not a "tenant", so
  // this workflow exposes no tenant pill.
  "user-credentials-managerial": {
    kind: "event",
    supportedTargets: ["admin", "company"],
  },
  // Tenant pill gates only the WhatsApp copy; the portal credential email to
  // the tenant themselves always sends.
  "user-credentials-tenant": {
    kind: "event",
    supportedTargets: ["admin", "company", "tenant"],
  },
  // Immediate staff/company email alert when the WhatsApp QR session disconnects.
  "whatsapp-session-disconnected": {
    kind: "event",
    supportedTargets: ["admin", "company"],
  },
};

export function isBuiltInWorkflow(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(WORKFLOW_CATALOG, key);
}
