import { beforeEach, describe, expect, test, vi } from "vitest";

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

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const TENANT_ID = "22222222-2222-4222-8222-222222222222";

const tenantRow = vi.fn();
const rpc = vi.fn();

// The stub answers only the tables the request may read. Anything else throws,
// so a send that reached the database would fail the test instead of passing it.
const dbClient = {
  from: (table: string) => {
    if (table === "tenants") return { select: () => ({ eq: () => ({ single: tenantRow }) }) };
    throw new Error(`Unexpected table in test: ${table}`);
  },
  rpc: (...args: unknown[]) => rpc(...args),
};

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => dbClient,
}));

vi.mock("@/company/requestCompany.server", () => ({
  getRequestCompany: () => ({
    id: COMPANY_ID,
    slug: "danat",
    status: "active",
    host: "danat.localhost",
  }),
  requireRequestCompany: () => ({
    id: COMPANY_ID,
    slug: "danat",
    status: "active",
    host: "danat.localhost",
  }),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: vi.fn() }));

const { sendCompanyInfo } = await import("./sendCompanyInfo");

const context = {
  userId: "user-1",
  supabase: { rpc: async () => ({ data: true, error: null }) },
};

const send = (channels: ("email" | "whatsapp")[], locale?: "ar" | "en") =>
  (sendCompanyInfo as unknown as (a: { data: unknown; context: unknown }) => Promise<unknown>)({
    data: { tenantId: TENANT_ID, channels, locale },
    context,
  });

beforeEach(() => {
  vi.clearAllMocks();
  tenantRow.mockResolvedValue({
    data: {
      id: TENANT_ID,
      email: "tenant@example.test",
      whatsapp: "+96550000000",
      mobile: null,
      preferred_language: "ar",
    },
    error: null,
  });
  rpc.mockResolvedValue({ data: "job-1", error: null });
});

describe("sendCompanyInfo queues the document instead of sending it", () => {
  test.each([["email"] as const, ["whatsapp"] as const, ["email", "whatsapp"] as const])(
    "queues one job for the selected channels %j",
    async (...channels) => {
      const result = (await send(channels)) as { queued: boolean; jobRequestIds: string[] };

      // One row in the outbox. The payload reached it only because it passed the
      // catalogue's schema: `enqueueJob` parses it before the insert.
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledWith("enqueue_job", {
        _kind: "company.info.send",
        _payload: { tenantId: TENANT_ID, channels: [...channels], language: "ar" },
        _dedupe_key: null,
        _requested_by: null,
      });
      expect(result).toEqual({ queued: true, jobRequestIds: ["job-1"] });
    },
  );

  test("carries the language the staff member chose, not the tenant's", async () => {
    await send(["email"], "en");

    const args = rpc.mock.calls[0]?.[1] as { _payload: { language: string } };
    expect(args._payload.language).toBe("en");
  });

  test("falls back to the tenant's preferred language when the dialog left it on auto", async () => {
    await send(["email"]);

    const args = rpc.mock.calls[0]?.[1] as { _payload: { language: string } };
    expect(args._payload.language).toBe("ar");
  });

  test("carries no dedupe key, so an admin may send the information again", async () => {
    await send(["email"]);

    const args = rpc.mock.calls[0]?.[1] as { _dedupe_key: string | null };
    expect(args._dedupe_key).toBeNull();
  });

  test("refuses a tenant with no contact on the selected channels", async () => {
    tenantRow.mockResolvedValue({
      data: {
        id: TENANT_ID,
        email: null,
        whatsapp: null,
        mobile: null,
        preferred_language: "ar",
      },
      error: null,
    });

    await expect(send(["whatsapp"])).rejects.toThrow("The tenant has no contact");
    expect(rpc).not.toHaveBeenCalled();
  });
});
