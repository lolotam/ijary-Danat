import { beforeEach, describe, expect, it, test, vi } from "vitest";

vi.mock("@tanstack/react-start", () => {
  const fn: {
    (input: { data: unknown; context: unknown }): unknown;
    _handler?: (args: { data: unknown; context: unknown }) => unknown;
    middleware: ReturnType<typeof vi.fn>;
    inputValidator: ReturnType<typeof vi.fn>;
    validator: ReturnType<typeof vi.fn>;
    handler: ReturnType<typeof vi.fn>;
  } = ((args: { data: unknown; context: unknown }) => fn._handler?.(args)) as never;
  fn.middleware = vi.fn().mockReturnValue(fn);
  fn.inputValidator = vi.fn().mockReturnValue(fn);
  fn.validator = vi.fn().mockReturnValue(fn);
  fn.handler = vi.fn().mockImplementation((h) => {
    fn._handler = h;
    return fn;
  });
  return {
    createServerFn: vi.fn().mockReturnValue(fn),
    createMiddleware: vi.fn().mockReturnValue({
      server: vi.fn().mockImplementation((middlewareFn) => middlewareFn),
    }),
  };
});

const from = vi.fn();
const rpc = vi.fn();
const buildFinalMessage = vi.fn();

const TEST_COMPANY = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "danat",
  status: "active" as const,
};

/** The catalogue schema only accepts a uuid, and the row id is what it carries. */
const NOTIFICATION_ID = "11111111-1111-4111-8111-111111111111";

vi.mock("@/company/requestCompany.server", () => ({
  getRequestCompany: () => TEST_COMPANY,
  requireRequestCompany: () => TEST_COMPANY,
  runWithRequestCompany: async (_company: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => ({
    from: (...args: unknown[]) => from(...args),
    rpc: (...args: unknown[]) => rpc(...args),
  }),
}));

vi.mock("@/fns/resolveTemplateVariables.server", () => ({
  buildFinalMessage: (...args: unknown[]) => buildFinalMessage(...args),
}));

const { sendNotification, sendNotificationSchema } = await import("./sendNotification");

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const CONTRACT_B = "33333333-3333-4333-8333-333333333333";

/**
 * يحوّل رمز القالب المطلوب إلى نوعه دون الاعتماد على صف وهمي ثابت.
 *
 * The previous fixture returned overdue_reminder for every code, so a test
 * asking for payment-admin-alert was judged on the wrong type.
 */
function typeFromRequestedCode(code: string): string {
  const byCode: Record<string, string> = {
    "overdue-reminder": "overdue_reminder",
    "overdue-reminder-ar": "overdue_reminder",
    "overdue-reminder-en": "overdue_reminder",
    receipt: "receipt",
    "payment-admin-alert": "payment_admin_alert",
    "due-reminder": "due_reminder",
    "contract-expiry": "contract_expiry",
  };
  return byCode[code] ?? code.replaceAll("-", "_");
}

const context = {
  userId: "user-1",
  supabase: {
    rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
  },
};

/**
 * يستدعي معالج sendNotification مباشرة عبر mock createServerFn.
 */
function callSend(data: unknown) {
  return (
    sendNotification as unknown as (a: { data: unknown; context: unknown }) => Promise<unknown>
  )({ data, context });
}

let lastInsert: Record<string, unknown> | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  lastInsert = null;
  context.supabase.rpc.mockResolvedValue({ data: true, error: null });
  rpc.mockResolvedValue({ data: "job-1", error: null });
  buildFinalMessage.mockResolvedValue({
    variables: {
      tenant_name: "أحمد",
      company_name: "دانة",
      outstanding: "250.000 KWD",
      days_overdue: "12",
    },
    subject: "متأخر (12 يوم)",
    bodyHtml: "رصيد 250.000 KWD",
    bodyText: "رصيد 250.000 KWD",
    missing: [],
    templateCode: "overdue-reminder-ar",
    templateType: "overdue_reminder",
    locale: "ar",
    unavailableReason: null,
  });

  from.mockImplementation((table: string) => {
    if (table === "tenants") {
      return {
        select: () => ({
          eq: () => ({
            single: () =>
              Promise.resolve({
                data: {
                  id: TENANT_ID,
                  name: "أحمد",
                  email: "a@example.test",
                  whatsapp: null,
                  mobile: null,
                  company_id: null,
                  preferred_language: "ar",
                  reminders_enabled: true,
                },
                error: null,
              }),
          }),
        }),
      };
    }
    if (table === "notification_templates") {
      return {
        select: () => ({
          eq: (_column: string, code: string) => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: {
                    code,
                    type: typeFromRequestedCode(code),
                    locale: "ar",
                    channel: "both",
                    is_active: true,
                  },
                  error: null,
                }),
            }),
          }),
        }),
      };
    }
    if (table === "cron_jobs") {
      const result = Promise.resolve({
        data: [
          { key: "overdue-reminders", recipient_targets: ["tenant"] },
          { key: "payment-succeeded", recipient_targets: ["admin", "company", "tenant"] },
          { key: "manual-payment-invoice", recipient_targets: ["admin", "company", "tenant"] },
          { key: "contract-expiry", recipient_targets: ["admin", "company", "tenant"] },
        ],
        error: null,
      });
      return {
        select: () => result,
      };
    }
    if (table === "notifications") {
      return {
        insert: (row: Record<string, unknown>) => {
          lastInsert = row;
          return {
            select: () => ({
              single: () =>
                Promise.resolve({
                  data: {
                    id: NOTIFICATION_ID,
                    channel: "email",
                    state: "queued",
                    tenant_id: TENANT_ID,
                    type: "manual_message",
                    ...row,
                  },
                  error: null,
                }),
            }),
          };
        },
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
});

describe("sendNotificationSchema", () => {
  it("accepts contractId", () => {
    expect(
      sendNotificationSchema.safeParse({
        tenantId: TENANT_ID,
        channel: "email",
        type: "manual_message",
        body: "hi",
        contractId: CONTRACT_B,
      }).success,
    ).toBe(true);
  });
});

describe("sendNotification persists builder output", () => {
  it("previews byte-for-byte what the send persists", async () => {
    const preview = await buildFinalMessage({
      tenantId: TENANT_ID,
      templateCode: "overdue-reminder-ar",
      locale: "ar",
      contractId: null,
    });

    await callSend({
      tenantId: TENANT_ID,
      type: "manual_message",
      channel: "email",
      locale: "ar",
      templateCode: "overdue-reminder-ar",
    });

    expect(lastInsert?.subject).toBe(preview.subject);
    expect(lastInsert?.body).toBe(preview.bodyHtml);
  });

  it("does not re-render after buildFinalMessage", async () => {
    await callSend({
      tenantId: TENANT_ID,
      type: "manual_message",
      channel: "email",
      locale: "ar",
      templateCode: "overdue-reminder-ar",
    });

    expect(buildFinalMessage).toHaveBeenCalledTimes(1);
    expect(lastInsert?.subject).toBe("متأخر (12 يوم)");
    expect(lastInsert?.body).toBe("رصيد 250.000 KWD");
  });

  it("passes overrides into the builder so preview and send share them", async () => {
    await callSend({
      tenantId: TENANT_ID,
      type: "manual_message",
      channel: "email",
      locale: "ar",
      templateCode: "overdue-reminder-ar",
      variables: { outstanding: "999.000 KWD" },
      subject: "override subject",
      body: null,
    });

    expect(buildFinalMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        variables: { outstanding: "999.000 KWD" },
        subject: "override subject",
        body: null,
      }),
    );
  });

  it("passes contractId through to the builder", async () => {
    await callSend({
      tenantId: TENANT_ID,
      type: "manual_message",
      channel: "email",
      locale: "ar",
      templateCode: "overdue-reminder-ar",
      contractId: CONTRACT_B,
    });

    expect(buildFinalMessage).toHaveBeenCalledWith(
      expect.objectContaining({ contractId: CONTRACT_B }),
    );
  });
});

describe("sendNotification leaves the row to the notify worker", () => {
  it("queues the row and enqueues one notification.dispatch job for it", async () => {
    const row = await callSend({
      tenantId: TENANT_ID,
      type: "manual_message",
      channel: "email",
      locale: "ar",
      templateCode: "overdue-reminder-ar",
    });

    expect(row).toMatchObject({ id: NOTIFICATION_ID, state: "queued" });
    expect(rpc).toHaveBeenCalledWith("enqueue_job", {
      _kind: "notification.dispatch",
      _payload: { notificationId: NOTIFICATION_ID },
      _dedupe_key: `notification.dispatch:${NOTIFICATION_ID}`,
      // The staff member who pressed send is who the job's notice goes to.
      _requested_by: "user-1",
    });
  });

  it("enqueues nothing for a message scheduled for later", async () => {
    // The row waits for its own time, so the drain job owns it — a job now
    // would send it early.
    await callSend({
      tenantId: TENANT_ID,
      type: "manual_message",
      channel: "email",
      locale: "ar",
      templateCode: "overdue-reminder-ar",
      scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("sendNotification eligibility gate", () => {
  test("rejects a template the tenant may not receive", async () => {
    await expect(
      callSend({
        tenantId: TENANT_ID,
        type: "manual_message",
        channel: "email",
        templateCode: "payment-admin-alert",
        locale: null,
        subject: null,
        body: null,
        contractId: null,
      }),
    ).rejects.toThrow(/not available for manual sending/i);
    expect(lastInsert).toBeNull();
  });

  /**
   * `unavailableReason` is a contract with three consumers. This is the
   * single-send half: the builder reporting it is worthless if the sender queues
   * the message anyway.
   *
   * It must REJECT, not throw a Response. TanStack resolves a thrown Response
   * client-side via x-tss-raw, so the dialog's catch never ran and the admin saw
   * a success toast for a message that was never sent.
   */
  test("refuses to send when the template is unavailable, and enqueues nothing", async () => {
    buildFinalMessage.mockResolvedValueOnce({
      variables: {},
      subject: "",
      bodyHtml: "",
      bodyText: "",
      missing: [],
      templateCode: null,
      templateType: null,
      locale: "ar",
      unavailableReason: "No active template for receipt.",
    });

    const error = await callSend({
      tenantId: TENANT_ID,
      type: "manual_message",
      channel: "email",
      templateCode: "receipt",
      locale: null,
      subject: null,
      body: null,
      contractId: null,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/no active template/i);
    expect(lastInsert).toBeNull();
  });

  // User decision M10: a template whose placeholders did not all resolve is
  // refused outright, naming the keys, instead of mailing the tenant a
  // message with blanks where the amount and reason should be.
  test("refuses to send while any variable is unresolved, naming them, and enqueues nothing", async () => {
    buildFinalMessage.mockResolvedValueOnce({
      variables: { tenant_name: "Ali" },
      subject: "نزاع على فاتورة - ",
      bodyHtml: "<p></p>",
      bodyText: "",
      missing: ["amount", "invoice_code"],
      templateCode: "invoice_disputed",
      templateType: "invoice_disputed",
      locale: "ar",
      unavailableReason: null,
    });

    const error = await callSend({
      tenantId: TENANT_ID,
      type: "manual_message",
      channel: "email",
      templateCode: "receipt",
      locale: null,
      subject: null,
      body: null,
      contractId: null,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("{{amount}}, {{invoice_code}}");
    expect(lastInsert).toBeNull();
  });

  test("accepts an eligible template", async () => {
    await callSend({
      tenantId: TENANT_ID,
      type: "manual_message",
      channel: "email",
      templateCode: "receipt",
      locale: null,
      subject: null,
      body: null,
      contractId: null,
    });
    expect(lastInsert).not.toBeNull();
  });

  test("accepts free text with no template code", async () => {
    await callSend({
      tenantId: TENANT_ID,
      type: "manual_message",
      channel: "email",
      templateCode: null,
      locale: null,
      subject: null,
      body: "hello",
      contractId: null,
    });
    expect(lastInsert).not.toBeNull();
  });
});
