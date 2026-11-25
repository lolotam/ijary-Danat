import { beforeEach, describe, expect, test, vi } from "vitest";

const workflowRow = vi.fn();
const invoiceRow = vi.fn();
const existingNotifications = vi.fn();
const templateRow = vi.fn();
const rpc = vi.fn();
const enqueue = vi.fn();

const INVOICE_ID = "44444444-4444-4444-8444-444444444444";
const REASON = "Bad debt write-off";

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "cron_jobs") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: workflowRow }),
          }),
        };
      }
      if (table === "invoices") {
        return {
          select: () => ({
            eq: () => ({ single: invoiceRow }),
          }),
        };
      }
      if (table === "notifications") {
        return {
          select: () => ({
            eq: () => ({
              contains: () => ({
                neq: () => ({ limit: existingNotifications }),
              }),
            }),
          }),
        };
      }
      if (table === "notification_templates") {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ maybeSingle: templateRow }) }),
          }),
        };
      }
      if (table === "companies") {
        return {
          select: () => ({
            order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null }) }) }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null }) }),
        }),
      };
    },
    rpc: (...args: unknown[]) => rpc(...args),
  },
}));

const resolveRecipients = vi.fn(async (targets: string[]) =>
  targets.includes("admin") || targets.includes("company")
    ? targets.includes("company") && !targets.includes("admin")
      ? ["company@example.test"]
      : ["admin@example.test"]
    : [],
);

vi.mock("@/fns/enqueueNotification", () => ({
  enqueueNotification: (...args: unknown[]) => enqueue(...args),
  resolveNotificationRecipients: (...args: unknown[]) => resolveRecipients(...(args as [string[]])),
}));

const { notifyInvoiceWrittenOffRecord } = await import("./notifyInvoiceWrittenOff");

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: null, error: null });
  invoiceRow.mockResolvedValue({
    data: {
      id: INVOICE_ID,
      code: "INV-2026-0042",
      tenant_id: "tenant-1",
      contract_id: "contract-1",
      balance: "250.000",
      dispute_reason: null,
    },
    error: null,
  });
  templateRow.mockResolvedValue({ data: null, error: null });
  existingNotifications.mockResolvedValue({ data: [], error: null });
  enqueue.mockResolvedValue({ id: "notification-1" });
});

describe("the invoice-written-off workflow switch", () => {
  test("a paused workflow enqueues nothing", async () => {
    workflowRow.mockResolvedValue({ data: { is_active: false }, error: null });

    const result = await notifyInvoiceWrittenOffRecord(INVOICE_ID, REASON);

    expect(enqueue).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: true });
  });

  test("a paused run is recorded against its OWN registry key", async () => {
    workflowRow.mockResolvedValue({ data: { is_active: false }, error: null });

    await notifyInvoiceWrittenOffRecord(INVOICE_ID, REASON);

    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _key: "invoice-written-off", _status: "skipped" }),
    );
  });

  test("an already-notified invoice records skipped instead of success", async () => {
    workflowRow.mockResolvedValue({ data: { is_active: true }, error: null });
    existingNotifications.mockResolvedValue({ data: [{ id: "existing" }], error: null });

    const result = await notifyInvoiceWrittenOffRecord(INVOICE_ID, REASON);

    expect(enqueue).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: true });
    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _status: "skipped", _error: "Already notified." }),
    );
  });

  test("a send failure does not reject the caller", async () => {
    workflowRow.mockResolvedValue({ data: { is_active: true }, error: null });
    enqueue.mockRejectedValue(new Error("smtp down"));

    const result = await notifyInvoiceWrittenOffRecord(INVOICE_ID, REASON);

    expect(result).toMatchObject({ skipped: true, reason: "smtp down" });
  });
});
