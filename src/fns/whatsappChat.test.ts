import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * مسار الإرسال من ملحن صندوق الوارد: أيّ اتصال يرسل عبره.
 *
 * The composer is the second caller of the delivery layer (the first is the
 * notification dispatcher), so the connection it reads decides whose number
 * the message goes out from — and it must be this company's own.
 */

vi.mock("@tanstack/react-start", () => ({
  createServerFn: vi.fn().mockImplementation(() => {
    const fn: any = (input?: { data?: unknown }) =>
      fn._handler({ data: input?.data, context: fn._context });
    fn._context = {
      supabase: { rpc: async () => ({ data: true, error: null }) },
      userId: "admin-user",
    };
    fn.middleware = vi.fn().mockReturnValue(fn);
    fn.validator = vi.fn().mockReturnValue(fn);
    fn.inputValidator = vi.fn().mockReturnValue(fn);
    fn.handler = vi.fn().mockImplementation((handler: any) => {
      fn._handler = handler;
      return fn;
    });
    return fn;
  }),
  createMiddleware: vi.fn().mockReturnValue({ server: vi.fn() }),
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: vi.fn() }));

// The avatar backfill reaches the worker's company-moment helper, which builds
// the service-role client at import time; the test never touches it.
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

const TEST_COMPANY = {
  id: "00000000-0000-4000-8000-000000000001",
  slug: "acme",
  status: "active" as const,
  host: "acme.ijary.app",
};

const db = {
  /** the company's active `evolution_qr` connection row (null = never paired). */
  connection: null as Record<string, unknown> | null,
  provider: {
    provider: "evolution_api",
    is_enabled: true,
    from_whatsapp: null,
    config: { api_base: "http://evolution:8080", api_key_env: "EVOLUTION_API_KEY" },
  } as Record<string, unknown>,
  /** rows the delivery layer recorded in the inbox. */
  ingested: [] as Record<string, unknown>[],
};

vi.mock("@/company/requestCompany.server", () => ({
  getRequestCompany: () => TEST_COMPANY,
  requireRequestCompany: () => TEST_COMPANY,
  runWithRequestCompany: async (_company: unknown, fn: () => unknown) => fn(),
}));

/**
 * بديل مبسّط لعميل Supabase: يطبّق المرشِّحات على الصفوف المخزّنة.
 *
 * The database is a system boundary, so it is faked here; what the assertions
 * care about is WHICH connection row the query can reach.
 */
function createFakeClient() {
  return {
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters.push([column, value]);
          return builder;
        },
        in: () => Promise.resolve({ data: [], error: null }),
        maybeSingle: async () => {
          if (table === "provider_configs") {
            const matched = filters.every(([column, value]) => db.provider[column] === value);
            return { data: matched ? db.provider : null, error: null };
          }
          if (table === "whatsapp_connections") {
            const row = db.connection;
            const matched =
              row && filters.every(([column, value]) => row[column] === value) ? row : null;
            return { data: matched, error: null };
          }
          return { data: null, error: null };
        },
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(resolve),
      };
      return builder;
    },
    rpc: async (_name: string, args: { p_rows: Record<string, unknown>[] }) => {
      db.ingested.push(...args.p_rows);
      return { data: args.p_rows.length, error: null };
    },
    storage: {
      from: () => ({ upload: async () => ({ data: null, error: null }) }),
    },
  };
}

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => createFakeClient(),
  serverCompanyClient: () => ({ companyId: TEST_COMPANY.id, client: createFakeClient() }),
}));

vi.mock("@/fns/evolutionSessionWatch", () => ({
  reportSendSessionDisconnected: vi.fn().mockResolvedValue(undefined),
}));

const { sendWhatsAppChatMessage } = await import("./whatsappChat");

/** صفّ اتصال واتساب النشط للشركة. */
function qrConnection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    company_id: TEST_COMPANY.id,
    method: "evolution_qr",
    is_active: true,
    status: "connected",
    instance_name: "ijary-00000000000040008000000000000001",
    ...overrides,
  };
}

beforeEach(() => {
  db.connection = qrConnection();
  db.ingested = [];
  vi.stubGlobal("fetch", vi.fn());
  vi.stubEnv("EVOLUTION_API_KEY", "evo-key");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("sendWhatsAppChatMessage", () => {
  it("sends through the company's own active QR connection", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ key: { id: "evo-1" } }), { status: 201 }),
    );

    const result = await sendWhatsAppChatMessage({
      data: { chatNumber: "96550123456", body: "مرحبا" },
    });

    expect(result).toEqual({ messageId: "evo-1" });
    expect(String(vi.mocked(globalThis.fetch).mock.calls[0][0])).toBe(
      "http://evolution:8080/message/sendText/ijary-00000000000040008000000000000001",
    );
  });

  it("refuses to send when the company has no active connection", async () => {
    db.connection = null;

    await expect(
      sendWhatsAppChatMessage({ data: { chatNumber: "96550123456", body: "مرحبا" } }),
    ).rejects.toMatchObject({ code: "session_disconnected" });

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("never sends through another company's connection", async () => {
    db.connection = qrConnection({ company_id: "22222222-2222-4222-8222-222222222222" });

    await expect(
      sendWhatsAppChatMessage({ data: { chatNumber: "96550123456", body: "مرحبا" } }),
    ).rejects.toMatchObject({ code: "session_disconnected" });

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
