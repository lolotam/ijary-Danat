import { beforeEach, describe, expect, it, vi } from "vitest";

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
const enqueue = vi.fn();
const buildFinalMessage = vi.fn();
const writeAudit = vi.fn();

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (...args: unknown[]) => from(...args),
  },
}));

vi.mock("@/fns/enqueueNotification", () => ({
  enqueueNotification: (...args: unknown[]) => enqueue(...args),
}));

vi.mock("@/fns/resolveTemplateVariables", () => ({
  buildFinalMessage: (...args: unknown[]) => buildFinalMessage(...args),
}));

const { estimatedDrainCapacityWithinStaleWindow } = await import("./notificationDrainJob");
const { sendBulkNotification, sendBulkSchema, bulkDeliveryKey } =
  await import("./sendBulkNotification");

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const T3 = "33333333-3333-4333-8333-333333333333";
const T4 = "44444444-4444-4444-8444-444444444444";

const context = {
  userId: "user-1",
  supabase: {
    rpc: vi.fn(async (name: string) => {
      if (name === "has_permission") return { data: true, error: null };
      if (name === "write_audit") return writeAudit();
      return { data: null, error: null };
    }),
  },
};

/**
 * يستدعي معالج الإرسال الجماعي مباشرة.
 */
function callBulk(data: unknown) {
  return (
    sendBulkNotification as unknown as (a: { data: unknown; context: unknown }) => Promise<{
      queued: number;
      skipped: Array<{ tenantId: string; reason: string }>;
      drainCapacity: number;
      exceedsDrainCapacity: boolean;
      batchId: string;
    }>
  )({ data, context });
}

function tenantRow(
  id: string,
  opts: {
    email?: string | null;
    whatsapp?: string | null;
    reminders_enabled?: boolean;
    notifications_paused?: boolean;
    preferred_language?: "ar" | "en";
  } = {},
) {
  return {
    id,
    name: `Tenant ${id.slice(0, 4)}`,
    email: opts.email === undefined ? `${id.slice(0, 4)}@example.test` : opts.email,
    whatsapp: opts.whatsapp ?? null,
    mobile: null,
    reminders_enabled: opts.reminders_enabled ?? true,
    notifications_paused: opts.notifications_paused ?? false,
    preferred_language: opts.preferred_language ?? "ar",
    company_id: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  writeAudit.mockResolvedValue({ data: null, error: null });
  enqueue.mockImplementation(async (row: { tenantId?: string }) => ({
    id: `notif-${row.tenantId}`,
    state: "queued",
  }));
  buildFinalMessage.mockImplementation(async ({ tenantId }: { tenantId: string }) => {
    const outstanding =
      tenantId === T1 ? "100.000 KWD" : tenantId === T2 ? "200.000 KWD" : "0.000 KWD";
    return {
      variables: {
        tenant_name: `Tenant ${tenantId.slice(0, 4)}`,
        company_name: "دانة",
        outstanding,
        days_overdue: "5",
      },
      subject: outstanding,
      bodyHtml: `Balance ${outstanding}`,
      bodyText: `Balance ${outstanding}`,
      missing: [],
      templateCode: "overdue-reminder-ar",
      templateType: "overdue_reminder",
      locale: "ar",
      unavailableReason: null,
    };
  });

  from.mockImplementation((table: string) => {
    if (table === "tenants") {
      const allTenants = [
        tenantRow(T1),
        tenantRow(T2),
        tenantRow(T3, { reminders_enabled: false }),
        tenantRow(T4, { notifications_paused: true }),
      ];
      const result = Promise.resolve({ data: allTenants, error: null });
      return {
        select: () => ({
          in: (_col: string, ids: string[]) =>
            Promise.resolve({
              data: allTenants.filter((t) => ids.includes(t.id)),
              error: null,
            }),
          then: (result as Promise<unknown>).then.bind(result),
          catch: (result as Promise<unknown>).catch.bind(result),
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
                    type:
                      code === "payment-admin-alert"
                        ? "payment_admin_alert"
                        : code === "receipt"
                          ? "receipt"
                          : "overdue_reminder",
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
    if (table === "contracts") {
      return {
        select: () => ({
          eq: () => ({
            is: () =>
              Promise.resolve({
                data: [{ tenant_id: T1 }, { tenant_id: T2 }],
                error: null,
              }),
          }),
        }),
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
});

describe("sendBulkSchema", () => {
  it("rejects a payload with neither template nor body", () => {
    expect(sendBulkSchema.safeParse({ audience: "all", channel: "email" }).success).toBe(false);
  });
});

describe("bulkDeliveryKey", () => {
  it("is deterministic per batch/tenant/template/channel", () => {
    const a = bulkDeliveryKey({
      batchId: "b1",
      tenantId: T1,
      templateCode: "overdue-reminder-ar",
      channel: "email",
    });
    const b = bulkDeliveryKey({
      batchId: "b1",
      tenantId: T1,
      templateCode: "overdue-reminder-ar",
      channel: "email",
    });
    expect(a).toBe(b);
    expect(a).toContain(T1);
  });
});

describe("estimatedDrainCapacityWithinStaleWindow", () => {
  it("is batch limit × daily ticks inside 72h", () => {
    // 100 per run × floor(72/24)=3 → 300.
    expect(estimatedDrainCapacityWithinStaleWindow(100, 72, 24)).toBe(300);
  });
});

describe("sendBulkNotification", () => {
  it("queues one notification per eligible tenant", async () => {
    const result = await callBulk({
      audience: "all",
      channel: "email",
      locale: "ar",
      templateCode: "overdue-reminder-ar",
      respectRemindersEnabled: true,
    });
    expect(result.queued).toBe(2);
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it("skips tenants with reminders disabled by default", async () => {
    const result = await callBulk({
      audience: "all",
      channel: "email",
      locale: "ar",
      templateCode: "overdue-reminder-ar",
      respectRemindersEnabled: true,
    });
    expect(result.skipped).toEqual(
      expect.arrayContaining([{ tenantId: T3, reason: "reminders_disabled" }]),
    );
  });

  /**
   * الشقّ الجماعي من عقد `unavailableReason`: يتخطّى المستأجر بسبب صريح.
   *
   * The bulk half of the `unavailableReason` contract. Skipping matters more
   * here than on the single path: without it the loop would queue an empty
   * message to every tenant in the batch, and nothing downstream would notice.
   */
  it("skips a tenant whose template is unavailable, with a reason", async () => {
    buildFinalMessage.mockImplementation(async ({ tenantId }: { tenantId: string }) => ({
      variables: {},
      subject: "",
      bodyHtml: "",
      bodyText: "",
      missing: [],
      templateCode: null,
      templateType: null,
      locale: "ar",
      unavailableReason: tenantId === T1 ? "No active template for receipt." : null,
    }));

    const result = await callBulk({
      audience: "all",
      channel: "email",
      locale: "ar",
      templateCode: "receipt",
      respectRemindersEnabled: false,
    });

    expect(result.skipped).toEqual(
      expect.arrayContaining([{ tenantId: T1, reason: "template_unavailable" }]),
    );
  });

  // M10 on the bulk path: one tenant's unresolved placeholders skip that
  // tenant (naming the keys) instead of mailing them blanks — and do not stop
  // the rest of the batch.
  it("skips only the tenant whose variables did not resolve, naming the keys", async () => {
    buildFinalMessage.mockImplementation(async ({ tenantId }: { tenantId: string }) => ({
      variables: {},
      subject: "s",
      bodyHtml: "<p>b</p>",
      bodyText: "b",
      missing: tenantId === T1 ? ["amount"] : [],
      templateCode: "receipt",
      templateType: "receipt",
      locale: "ar",
      unavailableReason: null,
    }));

    const result = await callBulk({
      audience: "all",
      channel: "email",
      locale: "ar",
      templateCode: "receipt",
      respectRemindersEnabled: false,
    });

    expect(result.skipped).toEqual(
      expect.arrayContaining([{ tenantId: T1, reason: "unresolved_variables: amount" }]),
    );
    expect(
      result.skipped.some((row) => row.tenantId !== T1 && row.reason.startsWith("unresolved")),
    ).toBe(false);
  });

  it("sends to reminders-off tenants when the admin explicitly opts in", async () => {
    const result = await callBulk({
      audience: "all",
      channel: "email",
      locale: "ar",
      templateCode: "overdue-reminder-ar",
      respectRemindersEnabled: false,
    });
    expect(result.queued).toBe(3);
  });

  /**
   * المستأجر الذي أُوقف إشعاراته لا يصل إليه شيء، فتُتخطّى الدفعة له.
   *
   * The pause is checked before the reminders switch: the owner asked for
   * nothing to reach this tenant, so opting into reminders-off tenants cannot
   * put the row back in the queue.
   */
  it("skips a tenant whose notifications are paused, and enqueues nothing for them", async () => {
    const result = await callBulk({
      audience: "all",
      channel: "email",
      locale: "ar",
      templateCode: "overdue-reminder-ar",
      respectRemindersEnabled: false,
    });

    expect(result.skipped).toEqual(
      expect.arrayContaining([{ tenantId: T4, reason: "notifications_paused" }]),
    );
    const enqueuedTenants = enqueue.mock.calls.map(
      (call) => (call[0] as { tenantId: string }).tenantId,
    );
    expect(enqueuedTenants).not.toContain(T4);
  });

  it("skips, and reports, a tenant with no address for the channel", async () => {
    from.mockImplementation((table: string) => {
      if (table === "tenants") {
        const allTenants = [
          tenantRow(T1, { email: null }),
          tenantRow(T2),
          tenantRow(T3, { reminders_enabled: false }),
        ];
        const result = Promise.resolve({ data: allTenants, error: null });
        return {
          select: () => ({
            in: () => Promise.resolve({ data: allTenants, error: null }),
            then: (result as Promise<unknown>).then.bind(result),
            catch: (result as Promise<unknown>).catch.bind(result),
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
                      type: "overdue_reminder",
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
        const jobs = Promise.resolve({
          data: [{ key: "overdue-reminders", recipient_targets: ["tenant"] }],
          error: null,
        });
        return { select: () => jobs };
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const result = await callBulk({
      audience: "all",
      channel: "email",
      locale: "ar",
      templateCode: "overdue-reminder-ar",
      respectRemindersEnabled: true,
    });
    expect(result.skipped).toEqual(expect.arrayContaining([{ tenantId: T1, reason: "no_email" }]));
  });

  it("resolves variables per tenant via buildFinalMessage", async () => {
    await callBulk({
      audience: "all",
      channel: "email",
      locale: "ar",
      templateCode: "overdue-reminder-ar",
      respectRemindersEnabled: true,
    });

    expect(buildFinalMessage).toHaveBeenCalledTimes(2);
    const bodies = enqueue.mock.calls.map((call) => (call[0] as { body: string }).body);
    expect(bodies.some((b) => b.includes("100.000"))).toBe(true);
    expect(bodies.some((b) => b.includes("200.000"))).toBe(true);
  });

  it("passes dispatch:false and a deliveryKey inside the single enqueue object", async () => {
    await callBulk({
      audience: "all",
      channel: "email",
      locale: "ar",
      templateCode: "overdue-reminder-ar",
      respectRemindersEnabled: true,
    });
    for (const [arg] of enqueue.mock.calls) {
      expect(arg.dispatch).toBe(false);
      expect(arg.deliveryKey).toMatch(/^bulk:/);
      expect(arg.type).toBe("manual_message");
      // One-arg call shape — never a second options object.
      expect(enqueue.mock.calls[0]).toHaveLength(1);
    }
  });

  it("writes one audit row for the batch", async () => {
    await callBulk({
      audience: "all",
      channel: "email",
      locale: "ar",
      templateCode: "overdue-reminder-ar",
      respectRemindersEnabled: true,
    });
    expect(context.supabase.rpc).toHaveBeenCalledWith(
      "write_audit",
      expect.objectContaining({
        p_action: "notification.bulk_create",
      }),
    );
  });

  it("reports drain capacity so the UI can warn", async () => {
    const result = await callBulk({
      audience: "all",
      channel: "email",
      locale: "ar",
      templateCode: "overdue-reminder-ar",
      respectRemindersEnabled: true,
    });
    expect(result.drainCapacity).toBe(300);
    expect(result.exceedsDrainCapacity).toBe(false);
    expect(result.batchId).toBeTruthy();
  });
});
