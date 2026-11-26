import { beforeEach, describe, expect, test, vi } from "vitest";

const existingNotifications = vi.fn();
const templateRow = vi.fn();
const enqueue = vi.fn();
const resolveRecipients = vi.fn();

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
      if (table === "notifications") {
        return {
          select: () => ({
            eq: () => ({ contains: () => ({ neq: () => ({ limit: existingNotifications }) }) }),
          }),
        };
      }
      if (table === "notification_templates") {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: templateRow }) }) }) };
      }
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null }) }),
        }),
      };
    },
  }),
}));

vi.mock("@/fns/enqueueNotification", () => ({
  enqueueNotification: (...args: unknown[]) => enqueue(...args),
  resolveNotificationRecipients: (...args: unknown[]) => resolveRecipients(...args),
}));

const { enqueueAdminEmail, renderAdminEmailCopy } = await import("./adminEmailNotification");

const COPY = { body: "<p>body</p>", code: "refund-recorded", locale: "en" as const, subject: "S" };

/** مواصفة مُرسِل بسيطة لا تلمس قاعدة البيانات إلا عبر المسار المشترك. */
function spec(sendFailureReason?: string) {
  return {
    type: "refund_recorded" as const,
    load: async () => ({ id: "refund-1" }),
    dedupeMatch: { refund_id: "refund-1" },
    build: async () => ({ copy: COPY, payload: { refund_id: "refund-1" } }),
    sendFailureReason,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  existingNotifications.mockResolvedValue({ data: [], error: null });
  templateRow.mockResolvedValue({ data: null, error: null });
  resolveRecipients.mockResolvedValue(["admin@example.test", "owner@example.test"]);
  enqueue.mockResolvedValue({ id: "notification-1" });
});

describe("enqueueAdminEmail", () => {
  test("a queued row carries every resolved recipient in its payload", async () => {
    const result = await enqueueAdminEmail(spec(), ["admin"]);

    expect(result).toEqual({ skipped: false, notification: { id: "notification-1" } });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientAddress: "admin@example.test",
        payload: {
          refund_id: "refund-1",
          recipients: ["admin@example.test", "owner@example.test"],
        },
      }),
    );
  });

  test("a template switched off the email channel is reported as a skip, not a send", async () => {
    enqueue.mockResolvedValue(null);

    const result = await enqueueAdminEmail(spec(), ["admin"]);

    expect(result).toEqual({
      skipped: true,
      reason: "Template refund-recorded excludes the email channel.",
    });
  });

  test("without a send-failure reason, a failed insert reaches the caller", async () => {
    enqueue.mockRejectedValue(new Error("insert failed"));

    await expect(enqueueAdminEmail(spec(), ["admin"])).rejects.toThrow("insert failed");
  });

  test("with a send-failure reason, a failed insert becomes a skip carrying its message", async () => {
    enqueue.mockRejectedValue(new Error("insert failed"));

    const result = await enqueueAdminEmail(spec("Refund notification failed."), ["admin"]);

    expect(result).toEqual({ skipped: true, reason: "insert failed" });
  });

  test("a failure to load the row throws even when send failures are softened", async () => {
    const missing = { ...spec("soft"), load: async () => Promise.reject(new Error("no row")) };

    await expect(enqueueAdminEmail(missing, ["admin"])).rejects.toThrow("no row");
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("renderAdminEmailCopy", () => {
  test("the built-in fallback body only ever sees escaped variables", async () => {
    const copy = await renderAdminEmailCopy({
      code: "refund-recorded",
      locale: "en",
      variables: { tenant_name: "<script>x</script>" },
      fallbackSubject: "Refund recorded",
      fallbackBody: (safe) => `<p>${safe.tenant_name}</p>`,
    });

    expect(copy.subject).toBe("Refund recorded");
    expect(copy.body).toContain("&lt;script&gt;");
    expect(copy.body).not.toContain("<script>x");
  });
});
