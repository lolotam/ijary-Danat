import { describe, expect, test } from "vitest";

import { NOTIFICATION_TYPES } from "@/integrations/supabase/database.types";
import { WORKFLOW_CATALOG } from "@/lib/workflowCatalog";
import {
  MANUALLY_RENDERABLE_TYPES,
  TEMPLATE_TENANT_ELIGIBILITY,
  isTemplateOfferable,
} from "@/lib/templateEligibility";

const workflows = [
  { key: "overdue-reminders", recipient_targets: ["tenant"] },
  { key: "payment-succeeded", recipient_targets: ["admin", "company", "tenant"] },
  { key: "manual-payment-invoice", recipient_targets: ["admin", "company", "tenant"] },
  { key: "contract-expiry", recipient_targets: ["admin", "company", "tenant"] },
  { key: "deposit-confirmed", recipient_targets: ["admin", "company"] },
  { key: "user-credentials-tenant", recipient_targets: ["company", "tenant"] },
];

describe("TEMPLATE_TENANT_ELIGIBILITY", () => {
  // The whole map, not a sample. Asserting four entries lets sixteen wrong
  // mappings through, and a wrong mapping exposes a staff template to tenants.
  test("matches the spec exactly, for all twenty-one types", () => {
    expect(TEMPLATE_TENANT_ELIGIBILITY).toEqual({
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
    });
  });

  test("is total over NOTIFICATION_TYPES", () => {
    for (const type of NOTIFICATION_TYPES) {
      expect(TEMPLATE_TENANT_ELIGIBILITY[type]).toBeDefined();
    }
  });

  test("every viaWorkflows key exists in WORKFLOW_CATALOG", () => {
    for (const entry of Object.values(TEMPLATE_TENANT_ELIGIBILITY)) {
      if (entry.mode !== "viaWorkflows") continue;
      for (const key of entry.keys) expect(WORKFLOW_CATALOG[key]).toBeDefined();
    }
  });
});

describe("MANUALLY_RENDERABLE_TYPES", () => {
  test("holds exactly the four resolver-backed types", () => {
    expect([...MANUALLY_RENDERABLE_TYPES].sort()).toEqual(
      ["contract_expiry", "due_reminder", "overdue_reminder", "receipt"].sort(),
    );
  });
});

describe("isTemplateOfferable", () => {
  test("offers exactly the four types", () => {
    const offered = NOTIFICATION_TYPES.filter((t) => isTemplateOfferable(t, workflows));
    expect([...offered].sort()).toEqual(
      ["contract_expiry", "due_reminder", "overdue_reminder", "receipt"].sort(),
    );
  });

  // payment-succeeded carries `tenant` for its sibling receipt template.
  test("payment_admin_alert stays out despite its workflow's tenant pill", () => {
    expect(isTemplateOfferable("payment_admin_alert", workflows)).toBe(false);
  });

  test("document_send and user_credentials fail gate 2 despite passing gate 1", () => {
    expect(TEMPLATE_TENANT_ELIGIBILITY.document_send.mode).toBe("always");
    expect(isTemplateOfferable("document_send", workflows)).toBe(false);
    expect(isTemplateOfferable("user_credentials", workflows)).toBe(false);
  });

  test("unticking the tenant pill removes the template", () => {
    const without = workflows.map((w) =>
      w.key === "contract-expiry" ? { ...w, recipient_targets: ["admin"] } : w,
    );
    expect(isTemplateOfferable("contract_expiry", workflows)).toBe(true);
    expect(isTemplateOfferable("contract_expiry", without)).toBe(false);
  });

  test("always types are offered with no cron_jobs rows at all", () => {
    expect(isTemplateOfferable("due_reminder", [])).toBe(true);
  });

  test("an unknown workflow key is ignored, not treated as eligible", () => {
    expect(
      isTemplateOfferable("receipt", [{ key: "not-a-workflow", recipient_targets: ["tenant"] }]),
    ).toBe(false);
  });

  test("the gate is imported only by the two manual server functions", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of [
      "src/fns/enqueueNotification.ts",
      "src/fns/dispatchNotification.ts",
      "src/fns/dispatchNotification.server.ts",
      "src/fns/notificationDrainJob.ts",
    ]) {
      expect(readFileSync(file, "utf8")).not.toContain("isTemplateOfferable");
    }
  });
});
