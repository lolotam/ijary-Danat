import { beforeEach, describe, expect, test, vi } from "vitest";

const workflowRow = vi.fn();
const refundRow = vi.fn();
const existingNotifications = vi.fn();
const templateRow = vi.fn();
const rpc = vi.fn();
const enqueue = vi.fn();

const REFUND_ID = "55555555-5555-4555-8555-555555555555";

const TEST_COMPANY = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "danat",
  status: "active" as const,
};

vi.mock("@/company/requestCompany.server", () => ({
  getRequestCompany: () => TEST_COMPANY,
  requireRequestCompany: () => TEST_COMPANY,
  runWithRequestCompany: async (_company: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => ({
    from: (table: string) => {
      if (table === "cron_jobs") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: workflowRow }),
          }),
        };
      }
      if (table === "refunds") {
        return {
          select: () => ({
            eq: () => ({ single: refundRow }),
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
        // `.eq("code", …).eq("is_active", true).maybeSingle()` — two eqs, which
        // the catch-all below does not offer.
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ maybeSingle: templateRow }) }),
          }),
        };
      }
      if (table === "companies") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: null }) }),
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
  }),
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

const { notifyRefundRecordedRecord } = await import("./notifyRefundRecorded");

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: null, error: null });
  refundRow.mockResolvedValue({
    data: {
      id: REFUND_ID,
      tenant_id: "tenant-1",
      amount: "120.000",
      currency: "KWD",
      reason: "Overpaid rent",
      note: null,
    },
    error: null,
  });
  templateRow.mockResolvedValue({ data: null, error: null });
  existingNotifications.mockResolvedValue({ data: [], error: null });
  enqueue.mockResolvedValue({ id: "notification-1" });
});

describe("the refund-recorded workflow switch", () => {
  test("a paused workflow enqueues nothing", async () => {
    workflowRow.mockResolvedValue({ data: { is_active: false }, error: null });

    const result = await notifyRefundRecordedRecord(REFUND_ID);

    expect(enqueue).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: true });
  });

  test("a paused run is recorded against the refund workflow", async () => {
    workflowRow.mockResolvedValue({ data: { is_active: false }, error: null });

    await notifyRefundRecordedRecord(REFUND_ID);

    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _key: "refund-recorded", _status: "skipped" }),
    );
  });

  test("an already-notified refund records skipped instead of success", async () => {
    workflowRow.mockResolvedValue({ data: { is_active: true }, error: null });
    existingNotifications.mockResolvedValue({ data: [{ id: "existing" }], error: null });

    const result = await notifyRefundRecordedRecord(REFUND_ID);

    expect(enqueue).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: true });
    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _status: "skipped", _error: "Already notified." }),
    );
  });
});

describe("the stored template decides the mail", () => {
  test("the template body reaches the enqueued notification", async () => {
    // Proves the row is READ, not merely tagged on the notification via
    // templateCode. Without this, a sender could revert to its built-in body
    // and every other test here would still pass.
    workflowRow.mockResolvedValue({ data: { is_active: true }, error: null });
    templateRow.mockResolvedValue({
      data: {
        subject_ar: "س",
        subject_en: "S",
        body_ar: "<p>AR-MARKER</p>",
        body_en: "<p>EN-MARKER</p>",
      },
      error: null,
    });

    await notifyRefundRecordedRecord(REFUND_ID);

    // No company row, so the locale falls back to Arabic.
    expect(enqueue.mock.calls[0]?.[0]?.body).toContain("AR-MARKER");
  });

  test("a missing template falls back to the built-in copy and still sends", async () => {
    workflowRow.mockResolvedValue({ data: { is_active: true }, error: null });
    templateRow.mockResolvedValue({ data: null, error: null });

    await notifyRefundRecordedRecord(REFUND_ID);

    expect(enqueue).toHaveBeenCalled();
    expect((enqueue.mock.calls[0]?.[0]?.body as string).length).toBeGreaterThan(0);
  });
});

describe("recipient targets are address-level for admin/company", () => {
  test("admin off + company on still enqueues to the company email", async () => {
    workflowRow.mockResolvedValue({
      data: { is_active: true, recipient_targets: ["company"] },
      error: null,
    });

    await notifyRefundRecordedRecord(REFUND_ID);

    expect(enqueue).toHaveBeenCalled();
    expect(enqueue.mock.calls[0]?.[0]?.recipientAddress).toBe("company@example.test");
  });
});
