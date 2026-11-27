import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";

vi.mock("@tanstack/react-start", async () =>
  (await import("./dispatchNotification.testkit")).tanstackStartModule(),
);
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: vi.fn() }));
vi.mock("@/company/requestCompany.server", async () =>
  (await import("./dispatchNotification.testkit")).requestCompanyModule(),
);
vi.mock("@/company/companyClient.server", async () =>
  (await import("./dispatchNotification.testkit")).companyClientModule(),
);

import { companyClient } from "@/company/companyClient.server";

import { dispatchNotificationRecord } from "./dispatchNotification.server";
import {
  CLOUD,
  db,
  MAPPING,
  notification,
  requestedUrls,
  RESEND,
  resetDispatchFixtures,
  restoreDispatchFixtures,
  TEST_COMPANY,
} from "./dispatchNotification.testkit";

function mockRpcQuota(quotaResult: { data: boolean | null; error: { message: string } | null }) {
  const rpc = vi.mocked(companyClient(TEST_COMPANY.id).rpc);
  rpc.mockImplementation((fn: string) => {
    if (fn === "consume_whatsapp_quota") return Promise.resolve(quotaResult) as any;
    return Promise.resolve({ data: null, error: null }) as any;
  });
  return rpc;
}

function quotaCalls(rpc: ReturnType<typeof vi.fn>) {
  return rpc.mock.calls.filter(([fn]) => fn === "consume_whatsapp_quota");
}

describe("dispatchNotificationRecord — monthly WhatsApp quota (T129)", () => {
  beforeEach(() => {
    resetDispatchFixtures();
    mockRpcQuota({ data: true, error: null });
  });

  afterEach(() => {
    restoreDispatchFixtures();
    vi.clearAllMocks();
  });

  it("sends WhatsApp normally when consume_whatsapp_quota reserves a send", async () => {
    const rpc = mockRpcQuota({ data: true, error: null });
    db.notification = notification({ channel: "whatsapp", subject: null });
    db.providers = [CLOUD];
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: "wamid.quota-ok" }] }), { status: 200 }),
    );

    const result = await dispatchNotificationRecord("n-1", { companyId: TEST_COMPANY.id });

    expect(quotaCalls(rpc)).toHaveLength(1);
    expect(requestedUrls()).toEqual(["https://graph.facebook.com/v23.0/999/messages"]);
    expect(result.state).toBe("sent");
    expect(result.skip_reason ?? null).toBeNull();
  });

  it("skips WhatsApp with skip_reason='limit_reached' without calling provider when quota is exhausted", async () => {
    const rpc = mockRpcQuota({ data: false, error: null });
    db.notification = notification({ channel: "whatsapp", subject: null });
    db.providers = [CLOUD];

    const result = await dispatchNotificationRecord("n-1", { companyId: TEST_COMPANY.id });

    expect(quotaCalls(rpc)).toHaveLength(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(db.update).toMatchObject({
      state: "skipped",
      skip_reason: "limit_reached",
    });
    expect(result.state).toBe("skipped");
    expect(result.skip_reason).toBe("limit_reached");
  });

  it("keeps the row failed (and quota reserved) when the provider fails after quota reservation", async () => {
    const rpc = mockRpcQuota({ data: true, error: null });
    db.notification = notification({ channel: "whatsapp", subject: null });
    db.providers = [CLOUD];
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "provider down" } }), { status: 500 }),
    );

    const result = await dispatchNotificationRecord("n-1", { companyId: TEST_COMPANY.id });

    expect(quotaCalls(rpc)).toHaveLength(1);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(result.state).toBe("failed");
    expect(db.update?.skip_reason).toBeUndefined();
  });

  it("marks channel='both' as sent without skip_reason when email succeeds and WhatsApp hits quota limit", async () => {
    const rpc = mockRpcQuota({ data: false, error: null });
    db.notification = notification({ channel: "both" });
    db.providers = [RESEND, CLOUD];
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: "resend-both-1" }), { status: 200 }),
    );

    const result = await dispatchNotificationRecord("n-1", { companyId: TEST_COMPANY.id });

    expect(quotaCalls(rpc)).toHaveLength(1);
    expect(requestedUrls()).toEqual(["https://api.resend.com/emails"]);
    expect(result.state).toBe("sent");
    expect(db.update?.skip_reason).toBeUndefined();
  });

  it("fails the row without calling provider when consume_whatsapp_quota errors", async () => {
    const rpc = mockRpcQuota({ data: null, error: { message: "quota rpc failed" } });
    db.notification = notification({ channel: "whatsapp", subject: null });
    db.providers = [CLOUD];

    const result = await dispatchNotificationRecord("n-1", { companyId: TEST_COMPANY.id });

    expect(quotaCalls(rpc)).toHaveLength(1);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result.state).toBe("failed");
    expect(result.failure_reason).toContain("quota rpc failed");
  });

  test.each([
    {
      label: "email-only notification",
      setup: () => {
        db.notification = notification({ channel: "email" });
        db.providers = [RESEND];
        vi.mocked(globalThis.fetch).mockResolvedValue(
          new Response(JSON.stringify({ id: "resend-only" }), { status: 200 }),
        );
      },
    },
    {
      label: "tenant opted out of proactive reminders",
      setup: () => {
        db.notification = notification({
          channel: "whatsapp",
          type: "due_reminder",
          subject: null,
        });
        db.tenant = { ...db.tenant, reminders_enabled: false };
        db.providers = [CLOUD];
      },
    },
    {
      label: "tenant has no WhatsApp number",
      setup: () => {
        db.notification = notification({ channel: "whatsapp", subject: null });
        db.tenant = { ...db.tenant, whatsapp: null, mobile: null };
        db.providers = [CLOUD];
      },
    },
    {
      label: "no WhatsApp provider enabled",
      setup: () => {
        db.notification = notification({ channel: "whatsapp", subject: null });
        db.providers = [];
      },
    },
    {
      label: "missing approved Meta template",
      setup: () => {
        db.notification = notification({ channel: "whatsapp", subject: null });
        db.providers = [CLOUD];
        db.template = { ...MAPPING, provider_template_name: null };
      },
    },
  ])("does not consume WhatsApp quota for: $label", async ({ setup }) => {
    const rpc = mockRpcQuota({ data: true, error: null });
    setup();

    await dispatchNotificationRecord("n-1", { companyId: TEST_COMPANY.id });

    expect(quotaCalls(rpc)).toHaveLength(0);
  });

  test.each(["skipped", "sent", "cancelled"] as const)(
    "does not consume WhatsApp quota when retrying an already-final %s row",
    async (finalState) => {
      const rpc = mockRpcQuota({ data: true, error: null });
      db.notification = notification({
        channel: "whatsapp",
        state: finalState,
        skip_reason: finalState === "skipped" ? "limit_reached" : null,
        subject: null,
      });
      db.providers = [CLOUD];

      const result = await dispatchNotificationRecord("n-1", { companyId: TEST_COMPANY.id });

      expect(quotaCalls(rpc)).toHaveLength(0);
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(result.state).toBe(finalState);
    },
  );
});
