import { beforeEach, describe, expect, test, vi } from "vitest";

const workflowRow = vi.fn();
const inquiryRow = vi.fn();
const existingNotifications = vi.fn();
const companyRow = vi.fn();
const templateRow = vi.fn();
const rpc = vi.fn();
const enqueue = vi.fn();

const INQUIRY_ID = "33333333-3333-4333-8333-333333333333";

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
      if (table === "contact_inquiries") {
        return {
          select: () => ({
            eq: () => ({ single: inquiryRow }),
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
      if (table === "companies") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: companyRow }),
          }),
        };
      }
      if (table === "notification_templates") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: templateRow }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: () => ({ maybeSingle: vi.fn() }),
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

const { notifyContactInquiryRecord } = await import("./notifyContactInquiry");

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: null, error: null });
  inquiryRow.mockResolvedValue({ data: { id: INQUIRY_ID, name: "Sara" }, error: null });
  existingNotifications.mockResolvedValue({ data: [], error: null });
  companyRow.mockResolvedValue({ data: { default_locale: "en" }, error: null });
  templateRow.mockResolvedValue({ data: null, error: null });
  enqueue.mockResolvedValue({ id: "notification-1" });
});

describe("the contact-inquiry-received workflow switch", () => {
  test("a paused workflow enqueues nothing", async () => {
    workflowRow.mockResolvedValue({ data: { is_active: false }, error: null });

    const result = await notifyContactInquiryRecord(INQUIRY_ID);

    expect(enqueue).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: true });
  });

  test("a paused run is recorded against the contact inquiry workflow", async () => {
    workflowRow.mockResolvedValue({ data: { is_active: false }, error: null });

    await notifyContactInquiryRecord(INQUIRY_ID);

    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _key: "contact-inquiry-received", _status: "skipped" }),
    );
  });

  test("an already-notified inquiry records skipped instead of success", async () => {
    workflowRow.mockResolvedValue({ data: { is_active: true }, error: null });
    existingNotifications.mockResolvedValue({ data: [{ id: "existing" }], error: null });

    const result = await notifyContactInquiryRecord(INQUIRY_ID);

    expect(enqueue).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: true });
    expect(rpc).toHaveBeenCalledWith(
      "record_cron_run",
      expect.objectContaining({ _status: "skipped", _error: "Already notified." }),
    );
  });

  test("a missing template still escapes public form content", async () => {
    workflowRow.mockResolvedValue({ data: { is_active: true }, error: null });
    inquiryRow.mockResolvedValue({
      data: {
        id: INQUIRY_ID,
        name: "<script>alert('name')</script>",
        email: "sara@example.test",
        phone: null,
        message: "<img src=x onerror=alert('message')>",
      },
      error: null,
    });

    await notifyContactInquiryRecord(INQUIRY_ID);

    const body = enqueue.mock.calls[0]?.[0]?.body as string;
    expect(body).toContain("&lt;script&gt;");
    expect(body).toContain("&lt;img");
    expect(body).not.toContain("<script>");
    expect(body).not.toContain("<img");
  });
});

describe("what the public form can put in a Subject header", () => {
  test("the seeded migration-72 subject renders unescaped", async () => {
    // Migration 72 seeds subject_en = 'New contact inquiry - {{name}}', and the
    // name comes from a PUBLIC form. loadTemplateCopy used to escape subject
    // values along with body values, so "O'Brien & Sons" arrived in the admin's
    // inbox as "O&#39;Brien &amp; Sons" — and, because wrapLayout escapes the
    // title again, doubly so in the branded header.
    //
    // The exact seeded string is used rather than a stand-in: this is the row a
    // stranger can populate, and it is the one that had no coverage.
    workflowRow.mockResolvedValue({ data: { is_active: true }, error: null });
    inquiryRow.mockResolvedValue({
      data: {
        id: INQUIRY_ID,
        name: "O'Brien & Sons",
        email: "o@example.test",
        phone: "+96550000000",
        message: "Enquiry about unit A-12",
      },
      error: null,
    });
    templateRow.mockResolvedValue({
      data: {
        subject_ar: "طلب تواصل جديد - {{name}}",
        subject_en: "New contact inquiry - {{name}}",
        body_ar: "<p>{{name}}</p>",
        body_en: "<p>{{name}}</p>",
      },
      error: null,
    });

    await notifyContactInquiryRecord(INQUIRY_ID);

    const sent = enqueue.mock.calls[0]?.[0];
    expect(sent.subject).toBe("New contact inquiry - O'Brien & Sons");
    // The body is the other half of the contract: still escaped, because that
    // one really is markup.
    expect(sent.body).toContain("O&#39;Brien &amp; Sons");
  });
});

describe("recipient targets are address-level for admin/company", () => {
  test("admin off + company on still enqueues to the company email", async () => {
    workflowRow.mockResolvedValue({
      data: { is_active: true, recipient_targets: ["company"] },
      error: null,
    });
    inquiryRow.mockResolvedValue({
      data: {
        id: INQUIRY_ID,
        name: "Sara",
        email: "sara@example.test",
        phone: null,
        message: "Hello",
      },
      error: null,
    });

    await notifyContactInquiryRecord(INQUIRY_ID);

    expect(enqueue).toHaveBeenCalled();
    expect(enqueue.mock.calls[0]?.[0]?.recipientAddress).toBe("company@example.test");
  });
});
