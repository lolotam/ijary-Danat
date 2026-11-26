import { beforeEach, describe, expect, test, vi } from "vitest";

const tenantRow = vi.fn();
const templateRow = vi.fn();
const overdueInvoices = vi.fn();
const liveContracts = vi.fn();
const existingNotifications = vi.fn();
const rpc = vi.fn();
const enqueue = vi.fn();

const dbClient = {
  from: (table: string) => {
    if (table === "invoices") {
      // `.select(…).eq("state", "overdue").gt("balance", 0)`.
      return { select: () => ({ eq: () => ({ gt: overdueInvoices }) }) };
    }
    if (table === "contracts") {
      // `.select("id").in("id", […]).is("archived_at", null)`.
      return {
        select: () => ({
          in: () => ({
            is: liveContracts,
          }),
        }),
      };
    }
    if (table === "tenants") {
      return { select: () => ({ eq: () => ({ single: tenantRow }) }) };
    }
    if (table === "notifications") {
      // `.eq("tenant_id").eq("type").contains("payload").neq("state").limit(1)`.
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              contains: () => ({ neq: () => ({ limit: existingNotifications }) }),
            }),
          }),
        }),
      };
    }
    // notification_templates: `.eq("code").eq("is_active").maybeSingle()`.
    return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: templateRow }) }) }) };
  },
  rpc: (...args: unknown[]) => rpc(...args),
};

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => dbClient,
}));

// The company address is a database read at a boundary this file does not test
// (see src/company/companyUrl.test.ts).
vi.mock("@/company/companyUrl.server", () => ({
  companyOriginById: async () => "https://danat.ijary.app",
}));

vi.mock("@/company/requestCompany.server", () => ({
  requireRequestCompany: () => ({
    id: "11111111-1111-4111-8111-111111111111",
    slug: "danat",
    status: "active",
    host: "danat.localhost",
  }),
}));

vi.mock("@/fns/enqueueNotification", () => ({
  enqueueNotification: (...args: unknown[]) => enqueue(...args),
}));

vi.mock("@/fns/workflowRegistry", () => ({
  readWorkflowGate: async () => ({
    paused: false,
    targets: ["admin", "company", "tenant"],
  }),
}));

const { runOverdueRemindersJob } = await import("./overdueRemindersJob");

beforeEach(() => {
  vi.clearAllMocks();
  rpc.mockResolvedValue({ data: null, error: null });
  overdueInvoices.mockResolvedValue({
    data: [
      {
        id: "invoice-1",
        tenant_id: "tenant-1",
        contract_id: "contract-live",
        balance: "500.000",
        due_date: "2026-07-01",
        period_month: 7,
        period_year: 2026,
        code: "INV-1",
      },
    ],
    error: null,
  });
  liveContracts.mockResolvedValue({
    data: [{ id: "contract-live" }],
    error: null,
  });
  tenantRow.mockResolvedValue({
    data: {
      id: "tenant-1",
      name: "Ahmed",
      email: "tenant@example.test",
      whatsapp: "+96550000000",
      mobile: null,
      reminders_enabled: true,
      preferred_language: "en",
    },
    error: null,
  });
  existingNotifications.mockResolvedValue({ data: [], error: null });
  templateRow.mockResolvedValue({ data: null, error: null });
  enqueue.mockResolvedValue({ id: "notification-1" });
});

describe("skips are reported, not silent", () => {
  test("a tenant with reminders off is named in the run's audit row", async () => {
    tenantRow.mockResolvedValue({
      data: {
        id: "tenant-1",
        name: "Ahmed",
        email: "tenant@example.test",
        whatsapp: "+96550000000",
        mobile: null,
        reminders_enabled: false,
        preferred_language: "en",
      },
      error: null,
    });

    await runOverdueRemindersJob("2026-07-15");

    expect(enqueue).not.toHaveBeenCalled();
    const audit = rpc.mock.calls.find(([name]) => name === "write_audit")?.[1] as {
      p_after: { skipped: Array<{ tenant_id: string; reason: string }> };
    };
    expect(audit.p_after.skipped).toEqual([
      { tenant_id: "tenant-1", reason: expect.stringMatching(/reminders are disabled/i) },
    ]);
  });

  test("a tenant with no WhatsApp number is named in the run's audit row", async () => {
    tenantRow.mockResolvedValue({
      data: {
        id: "tenant-1",
        name: "Ahmed",
        email: "tenant@example.test",
        whatsapp: null,
        mobile: null,
        reminders_enabled: true,
        preferred_language: "en",
      },
      error: null,
    });

    await runOverdueRemindersJob("2026-07-15");

    // The email still goes; only the WhatsApp leg is reported missing.
    expect(enqueue.mock.calls.map(([a]) => a.channel)).toEqual(["email"]);
    const audit = rpc.mock.calls.find(([name]) => name === "write_audit")?.[1] as {
      p_after: { skipped: Array<{ reason: string }> };
    };
    expect(audit.p_after.skipped[0].reason).toMatch(/no WhatsApp number/i);
  });
});

describe("the stored template decides the overdue reminder", () => {
  test("the template body reaches the email", async () => {
    // Proves the row is READ, not merely tagged via templateCode. Without this,
    // reverting the sender to builtIn.html breaks nothing that anyone notices.
    templateRow.mockResolvedValue({
      data: {
        subject_ar: "س",
        subject_en: "S",
        body_ar: "<p>AR-MARKER</p>",
        body_en: "<p>EN-MARKER</p>",
        channel: "both",
      },
      error: null,
    });

    await runOverdueRemindersJob("2026-07-13");

    const email = enqueue.mock.calls.map(([a]) => a).find((a) => a.channel === "email");
    expect(email.body).toContain("EN-MARKER");
  });

  test("the WhatsApp leg is the same body flattened, not a second source", async () => {
    // Both legs derive from one authored body. Two hand-written bodies is how
    // the credentials mail came to say different things on each channel.
    templateRow.mockResolvedValue({
      data: {
        subject_ar: "س",
        subject_en: "S",
        body_ar: "<p>AR</p>",
        body_en: "<p>Overdue: 500.000 KWD</p>",
        channel: "both",
      },
      error: null,
    });

    await runOverdueRemindersJob("2026-07-13");

    const wa = enqueue.mock.calls.map(([a]) => a).find((a) => a.channel === "whatsapp");
    expect(wa.body).toContain("Overdue: 500.000 KWD");
    expect(wa.body).not.toContain("<p>");
    // An admin template that never mentions the portal would silently drop the
    // one thing this reminder exists to offer, so the link is appended when the
    // authored copy does not already carry it.
    expect(wa.body).toContain("/portal/invoices");
  });

  test("does not append the link twice when the authored copy already has it", async () => {
    templateRow.mockResolvedValue({
      data: {
        subject_ar: "س",
        subject_en: "S",
        body_ar: "<p>AR</p>",
        body_en: "<p>Pay at https://danat.ijary.app/portal/invoices</p>",
        channel: "both",
      },
      error: null,
    });

    await runOverdueRemindersJob("2026-07-13");

    const wa = enqueue.mock.calls.map(([a]) => a).find((a) => a.channel === "whatsapp");
    const occurrences = wa.body.split("/portal/invoices").length - 1;
    expect(occurrences).toBe(1);
  });

  test("carries pay_now_url in the payload for WhatsApp template binding", async () => {
    // An approved WhatsApp template binds parameters from the payload, never
    // from the rendered body — a link only in the body cannot reach a button.
    await runOverdueRemindersJob("2026-07-13");

    const wa = enqueue.mock.calls.map(([a]) => a).find((a) => a.channel === "whatsapp");
    expect(wa.payload.pay_now_url).toBe("https://danat.ijary.app/portal/invoices");
  });

  test("a missing template falls back to the built-in copy and still sends", async () => {
    templateRow.mockResolvedValue({ data: null, error: null });

    await runOverdueRemindersJob("2026-07-13");

    expect(enqueue).toHaveBeenCalled();
    for (const [arg] of enqueue.mock.calls) {
      expect((arg.body as string).length).toBeGreaterThan(0);
    }
  });
});

describe("archived contracts do not receive overdue dunning", () => {
  test("overdue on archived is dropped; overdue on live for the same tenant still enqueues", async () => {
    // Filter on the CONTRACT, not the tenant. Suppressing by tenant would
    // silence legitimate live arrears when one tenant holds both.
    overdueInvoices.mockResolvedValue({
      data: [
        {
          id: "invoice-archived",
          tenant_id: "tenant-1",
          contract_id: "contract-archived",
          balance: "200.000",
          due_date: "2026-06-01",
          period_month: 6,
          period_year: 2026,
          code: "INV-A",
        },
        {
          id: "invoice-live",
          tenant_id: "tenant-1",
          contract_id: "contract-live",
          balance: "300.000",
          due_date: "2026-07-01",
          period_month: 7,
          period_year: 2026,
          code: "INV-L",
        },
      ],
      error: null,
    });
    // Only the live contract is returned by `.is("archived_at", null)`.
    liveContracts.mockResolvedValue({
      data: [{ id: "contract-live" }],
      error: null,
    });

    await runOverdueRemindersJob("2026-07-13");

    expect(enqueue).toHaveBeenCalled();
    for (const [arg] of enqueue.mock.calls) {
      expect(arg.payload.invoice_ids).toEqual(["invoice-live"]);
      expect(arg.payload.invoice_ids).not.toContain("invoice-archived");
      // Outstanding quoted in the email must exclude the archived balance.
      expect(arg.payload.outstanding).toBe("300 KWD");
    }
  });

  test("all-archived overdue portfolio enqueues nothing", async () => {
    overdueInvoices.mockResolvedValue({
      data: [
        {
          id: "invoice-archived",
          tenant_id: "tenant-1",
          contract_id: "contract-archived",
          balance: "200.000",
          due_date: "2026-06-01",
          period_month: 6,
          period_year: 2026,
          code: "INV-A",
        },
      ],
      error: null,
    });
    liveContracts.mockResolvedValue({ data: [], error: null });

    await runOverdueRemindersJob("2026-07-13");

    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("the template's channel decides which rows exist", () => {
  // The reported bug: overdue-reminder was set to Email in the editor, yet the
  // job queued a WhatsApp row for every tenant holding a number, and the pool
  // filled with skipped WhatsApp reminders the admin never asked for.
  const authored = {
    subject_ar: "س",
    subject_en: "S",
    body_ar: "<p>AR</p>",
    body_en: "<p>EN</p>",
  };

  /** يجمع القنوات التي طُلب إنشاء صف لها فعلاً. */
  function enqueuedChannels(): string[] {
    return enqueue.mock.calls.map(([arg]) => arg.channel as string);
  }

  test("an email-only template enqueues no WhatsApp row even when a number exists", async () => {
    // The tenant fixture carries whatsapp "+96550000000", so a WhatsApp row is
    // available on every axis except the one that should decide it.
    templateRow.mockResolvedValue({ data: { ...authored, channel: "email" }, error: null });

    await runOverdueRemindersJob("2026-07-13");

    expect(enqueuedChannels()).toEqual(["email"]);
  });

  test("a whatsapp-only template enqueues no email row even when an address exists", async () => {
    templateRow.mockResolvedValue({ data: { ...authored, channel: "whatsapp" }, error: null });

    await runOverdueRemindersJob("2026-07-13");

    expect(enqueuedChannels()).toEqual(["whatsapp"]);
  });

  test("a both template enqueues exactly one row per channel", async () => {
    templateRow.mockResolvedValue({ data: { ...authored, channel: "both" }, error: null });

    await runOverdueRemindersJob("2026-07-13");

    expect(enqueuedChannels()).toEqual(["email", "whatsapp"]);
  });

  test("a dropped channel is not counted as queued", async () => {
    // `queued` feeds the job's audit row. Counting a row the gate refused to
    // create would report work that never happened.
    templateRow.mockResolvedValue({ data: { ...authored, channel: "email" }, error: null });

    const result = await runOverdueRemindersJob("2026-07-13");

    expect(result.count).toBe(1);
    expect(result.notifications).toHaveLength(1);
  });
});
