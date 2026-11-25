import { beforeEach, describe, expect, test, vi } from "vitest";

const workflowRow = vi.fn();
const requestRow = vi.fn();
const existingNotifications = vi.fn();
const templateRow = vi.fn();
const rpc = vi.fn();
const enqueue = vi.fn();

const REQUEST_ID = "44444444-4444-4444-8444-444444444444";

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
      if (table === "maintenance_requests") {
        return {
          select: () => ({
            eq: () => ({ single: requestRow }),
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
        // `.eq("code", …).eq("is_active", true).maybeSingle()` — two eqs. The
        // catch-all below offers only one, so routing this table by name is what
        // lets the happy path run at all.
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

const { notifyMaintenanceRequestRecord } = await import("./notifyMaintenanceRequest");

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: null, error: null });
  requestRow.mockResolvedValue({
    data: {
      id: REQUEST_ID,
      code: "MNT-1",
      title: "Leaking tap",
      priority: "high",
      unit_id: null,
    },
    error: null,
  });
  existingNotifications.mockResolvedValue({ data: [], error: null });
  templateRow.mockResolvedValue({ data: null, error: null });
  enqueue.mockResolvedValue({ id: "notification-1" });
});

describe("the stored template decides the mail", () => {
  test("the template body reaches the enqueued notification", async () => {
    // Proves the row is READ, not merely tagged on the notification via
    // templateCode. Editing this template in the admin screen has to change
    // what an admin receives, or the whole editor is decorative.
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

    await notifyMaintenanceRequestRecord(REQUEST_ID);

    // No company row, so the locale falls back to Arabic.
    expect(enqueue.mock.calls[0]?.[0]?.body).toContain("AR-MARKER");
  });

  test("a missing template falls back to the built-in copy and still sends", async () => {
    // A deleted or deactivated row must degrade to the built-in body, never to
    // sending nothing.
    workflowRow.mockResolvedValue({ data: { is_active: true }, error: null });
    templateRow.mockResolvedValue({ data: null, error: null });

    await notifyMaintenanceRequestRecord(REQUEST_ID);

    expect(enqueue).toHaveBeenCalled();
    expect((enqueue.mock.calls[0]?.[0]?.body as string).length).toBeGreaterThan(0);
  });
});

describe("the maintenance-request-created workflow switch", () => {
  test("a paused workflow enqueues nothing", async () => {
    workflowRow.mockResolvedValue({ data: { is_active: false }, error: null });

    const result = await notifyMaintenanceRequestRecord(REQUEST_ID);

    expect(enqueue).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: true });
  });

  test("a paused run is recorded against the maintenance workflow", async () => {
    workflowRow.mockResolvedValue({ data: { is_active: false }, error: null });

    await notifyMaintenanceRequestRecord(REQUEST_ID);

    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _key: "maintenance-request-created", _status: "skipped" }),
    );
  });

  test("an already-notified request records skipped instead of success", async () => {
    workflowRow.mockResolvedValue({ data: { is_active: true }, error: null });
    existingNotifications.mockResolvedValue({ data: [{ id: "existing" }], error: null });

    const result = await notifyMaintenanceRequestRecord(REQUEST_ID);

    expect(enqueue).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: true });
    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _status: "skipped", _error: "Already notified." }),
    );
  });
});

describe("recipient targets are address-level for admin/company", () => {
  test("admin off + company on still enqueues to the company email", async () => {
    workflowRow.mockResolvedValue({
      data: { is_active: true, recipient_targets: ["company"] },
      error: null,
    });

    await notifyMaintenanceRequestRecord(REQUEST_ID);

    expect(enqueue).toHaveBeenCalled();
    expect(enqueue.mock.calls[0]?.[0]?.recipientAddress).toBe("company@example.test");
  });
});
