import { beforeEach, describe, expect, test, vi } from "vitest";

const tenantRow = vi.fn();
const contractRow = vi.fn();
const companyRow = vi.fn();
const contractUnitRow = vi.fn();
const unitsRow = vi.fn();
const templateRow = vi.fn();
const priorNotifications = vi.fn();
const rpc = vi.fn();
const enqueue = vi.fn();
const adminRecipients = vi.fn();

const dbClient = {
  from: (table: string) => {
    if (table === "notifications") {
      // `.eq("contract_id").eq("type").in("state", […])`.
      return { select: () => ({ eq: () => ({ eq: () => ({ in: priorNotifications }) }) }) };
    }
    if (table === "tenants") return { select: () => ({ eq: () => ({ single: tenantRow }) }) };
    if (table === "contracts") return { select: () => ({ eq: () => ({ single: contractRow }) }) };
    // contract_units: `.select("unit_id").eq("contract_id", …).order("line_order")`.
    if (table === "contract_units") {
      return { select: () => ({ eq: () => ({ order: () => contractUnitRow() }) }) };
    }
    // units are resolved through contract_units now (migration 110); the
    // reminder names every unit the contract holds, via `.in(...)`.
    if (table === "units") return { select: () => ({ in: () => unitsRow() }) };
    if (table === "companies") {
      return {
        select: () => ({ eq: () => ({ maybeSingle: companyRow }) }),
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
  resolveNotificationRecipients: (...args: unknown[]) => adminRecipients(...args),
}));

vi.mock("@/fns/workflowRegistry", () => ({
  readWorkflowGate: async () => ({
    paused: false,
    targets: ["admin", "company", "tenant"],
  }),
}));

const { runContractExpiryJob } = await import("./contractExpiryJob");

beforeEach(() => {
  vi.clearAllMocks();
  adminRecipients.mockResolvedValue([]);
  rpc.mockImplementation(async (name: string) =>
    name === "identify_contract_expiry_reminders"
      ? {
          data: [
            {
              contract_id: "contract-1",
              tenant_id: "tenant-1",
              days_until: 9,
              milestone: "7d",
            },
          ],
          error: null,
        }
      : { data: null, error: null },
  );
  priorNotifications.mockResolvedValue({ data: [], error: null });
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
  contractRow.mockResolvedValue({
    data: { id: "contract-1", code: "CTR-1", end_date: "2026-12-31", unit_id: "unit-1" },
    error: null,
  });
  contractUnitRow.mockResolvedValue({ data: [{ unit_id: "unit-1" }], error: null });
  unitsRow.mockResolvedValue({ data: [{ code: "A-12", name: "Two-bed flat" }], error: null });
  companyRow.mockResolvedValue({
    data: { name_ar: "دانة المستقبل العقارية", name_en: "Danat Al Mustaqbal" },
    error: null,
  });
  templateRow.mockResolvedValue({ data: null, error: null });
  enqueue.mockResolvedValue({ id: "notification-1" });
});

/** The `p_after` of the run's audit row — where skips are reported. */
function auditAfter(): { queued: number; skipped: Array<{ reason: string }> } {
  const call = rpc.mock.calls.find(([name]) => name === "write_audit");
  return (call?.[1] as { p_after: { queued: number; skipped: Array<{ reason: string }> } }).p_after;
}

describe("the tenant WhatsApp leg", () => {
  test("is queued alongside the tenant email, to the tenant's number", async () => {
    await runContractExpiryJob("2026-12-22");

    const legs = enqueue.mock.calls.map(([a]) => a);
    const wa = legs.find((a) => a.channel === "whatsapp");
    expect(wa).toMatchObject({ audience: "tenant", recipientAddress: "+96550000000" });
    expect(wa.body).not.toContain("<");
    expect(wa.body).not.toContain("{{");
    expect(legs.some((a) => a.channel === "email" && a.audience === "tenant")).toBe(true);
  });

  test.each([
    {
      why: "reminders are disabled",
      tenant: { whatsapp: "+96550000000", reminders_enabled: false },
      reason: /reminders are disabled/i,
    },
    {
      why: "the tenant has no number",
      tenant: { whatsapp: null, reminders_enabled: true },
      reason: /no WhatsApp number/i,
    },
  ])("a leg dropped because $why is reported in the audit, not silently", async (scenario) => {
    tenantRow.mockResolvedValue({
      data: {
        id: "tenant-1",
        name: "Ahmed",
        email: "tenant@example.test",
        mobile: null,
        preferred_language: "en",
        ...scenario.tenant,
      },
      error: null,
    });

    await runContractExpiryJob("2026-12-22");

    expect(enqueue.mock.calls.some(([a]) => a.channel === "whatsapp")).toBe(false);
    const after = auditAfter();
    // Reminders-off drops BOTH tenant legs (email since Task 6, WhatsApp all
    // along) and reports each; a missing number drops only the WhatsApp leg.
    expect(after.skipped).toHaveLength(scenario.tenant.reminders_enabled ? 1 : 2);
    expect(after.skipped[0].reason).toMatch(scenario.reason);
  });

  test("reminders off drops both tenant legs and keeps the admin alert", async () => {
    // The tenant's reminders switch is channel-agnostic: opting out must
    // silence the tenant email too, while the office's own alert — which
    // carries the same tenant_id and type — must keep sending.
    adminRecipients.mockResolvedValue(["admin@example.test"]);
    tenantRow.mockResolvedValue({
      data: {
        id: "tenant-1",
        name: "Ahmed",
        email: "tenant@example.test",
        mobile: null,
        preferred_language: "en",
        whatsapp: "+96550000000",
        reminders_enabled: false,
      },
      error: null,
    });

    const result = await runContractExpiryJob("2026-12-22");

    const legs = enqueue.mock.calls.map(([a]) => a);
    expect(legs.some((a) => a.audience === "tenant")).toBe(false);
    expect(legs.some((a) => a.audience === "admin" && a.channel === "email")).toBe(true);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          leg: "email",
          reason: expect.stringMatching(/reminders are disabled/i),
        }),
      ]),
    );
  });

  test("an already-sent WhatsApp for this milestone is not re-queued, and says so", async () => {
    priorNotifications.mockResolvedValue({
      data: [
        {
          audience: "tenant",
          channel: "whatsapp",
          recipient_address: "+96550000000",
          payload: { milestone: "7d" },
        },
      ],
      error: null,
    });

    await runContractExpiryJob("2026-12-22");

    expect(enqueue.mock.calls.some(([a]) => a.channel === "whatsapp")).toBe(false);
    expect(auditAfter().skipped[0].reason).toMatch(/already/i);
  });
});

describe("the stored template decides the expiry notice", () => {
  test("the template body reaches the email", async () => {
    templateRow.mockResolvedValue({
      data: {
        subject_ar: "س",
        subject_en: "S",
        body_ar: "<p>AR-MARKER</p>",
        body_en: "<p>EN-MARKER</p>",
      },
      error: null,
    });

    await runContractExpiryJob("2026-12-22");

    const email = enqueue.mock.calls.map(([a]) => a).find((a) => a.channel === "email");
    expect(email.body).toContain("EN-MARKER");
  });

  test("the sender fills every placeholder migration 73 restored", async () => {
    // Migration 58 put {{unit}}, {{days_until}} and {{company_name}} in these
    // bodies; migration 70 dropped them and 73 put them back. A placeholder the
    // body uses but the sender never supplies ships as a literal {{token}} — to
    // a tenant, over WhatsApp. This is the test that would have caught it.
    templateRow.mockResolvedValue({
      data: {
        subject_ar: "س",
        subject_en: "S",
        body_ar: "<p>ar</p>",
        body_en:
          "<p>{{tenant_name}} {{contract_code}} {{unit}} {{days_until}} {{end_date}} {{company_name}}</p>",
      },
      error: null,
    });

    await runContractExpiryJob("2026-12-22");

    const email = enqueue.mock.calls.map(([a]) => a).find((a) => a.channel === "email");
    expect(email.body).not.toContain("{{");
    expect(email.body).toContain("A-12");
    expect(email.body).toContain("9");
    expect(email.body).toContain("Danat Al Mustaqbal");
  });

  test("a missing template falls back to the built-in copy and still sends", async () => {
    templateRow.mockResolvedValue({ data: null, error: null });

    await runContractExpiryJob("2026-12-22");

    expect(enqueue).toHaveBeenCalled();
    for (const [arg] of enqueue.mock.calls) {
      expect((arg.body as string).length).toBeGreaterThan(0);
    }
  });

  test("a multi-unit contract names every unit, not just the first", async () => {
    contractUnitRow.mockResolvedValue({
      data: [{ unit_id: "unit-1" }, { unit_id: "unit-2" }],
      error: null,
    });
    unitsRow.mockResolvedValue({
      data: [
        { code: "A-12", name: "Two-bed flat" },
        { code: "B-07", name: "Shop" },
      ],
      error: null,
    });
    templateRow.mockResolvedValue({
      data: { subject_ar: "س", subject_en: "S", body_ar: "<p>ar</p>", body_en: "<p>{{unit}}</p>" },
      error: null,
    });

    await runContractExpiryJob("2026-12-22");

    const email = enqueue.mock.calls.map(([a]) => a).find((a) => a.channel === "email");
    expect(email.body).toContain("A-12 — Two-bed flat, B-07 — Shop");
  });
});
