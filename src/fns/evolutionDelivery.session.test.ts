import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { EvolutionProviderError } from "@/lib/providers/evolution";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "22222222-2222-4222-8222-222222222222";

/** صفّ اتصال واتساب كما تكتبه قاعدة البيانات. */
interface ConnectionRow {
  id: string;
  company_id: string;
  method: string;
  is_active: boolean;
  status: string;
  instance_name: string | null;
}

const state = {
  connections: [] as ConnectionRow[],
  /** تحديثات `whatsapp_connections` بالترتيب. */
  updates: [] as { values: Record<string, unknown>; filters: Record<string, unknown> }[],
  /** صفوف الرسائل التي سجّلها المُرسِل في صندوق الوارد. */
  ingested: [] as Record<string, unknown>[],
};

const sendWithEvolutionMock = vi.fn();
const reportSendMock = vi.fn();

/**
 * بديل مبسّط لعميل Supabase: يطبّق المرشِّحات على صفوف الاتصال المخزّنة.
 *
 * The database is a system boundary, so it is faked here; what the assertions
 * care about is WHICH connection row the query can reach.
 */
function createFakeClient() {
  return {
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const builder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return builder;
        },
        in: () => Promise.resolve({ data: [], error: null }),
        maybeSingle: async () => {
          if (table !== "whatsapp_connections") {
            return { data: null, error: null };
          }
          const matched = state.connections.filter((row) =>
            Object.entries(filters).every(
              ([column, value]) => row[column as keyof ConnectionRow] === value,
            ),
          );
          return { data: matched[0] ?? null, error: null };
        },
        update: (values: Record<string, unknown>) => {
          state.updates.push({ values, filters: { ...filters } });
          return builder;
        },
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(resolve),
      };
      return builder;
    },
    rpc: async (_name: string, args: { p_rows: Record<string, unknown>[] }) => {
      state.ingested.push(...args.p_rows);
      return { data: args.p_rows.length, error: null };
    },
    storage: {
      from: () => ({ upload: async () => ({ data: null, error: null }) }),
    },
  };
}

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => createFakeClient(),
  serverCompanyClient: () => ({
    companyId: COMPANY_ID,
    client: createFakeClient(),
  }),
}));

// The avatar backfill reaches the worker's company-moment helper, which
// builds the service-role client at import time; the test never touches it.
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));

vi.mock("@/company/requestCompany.server", () => ({
  getRequestCompany: () => ({
    id: COMPANY_ID,
    slug: "acme",
    status: "active",
    host: "acme.ijary.app",
  }),
  requireRequestCompany: () => ({
    id: COMPANY_ID,
    slug: "acme",
    status: "active",
    host: "acme.ijary.app",
  }),
}));

vi.mock("@/lib/providers/evolution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/providers/evolution")>();
  return {
    ...actual,
    sendWithEvolution: (...args: unknown[]) => sendWithEvolutionMock(...args),
  };
});

vi.mock("@/fns/evolutionSessionWatch", () => ({
  reportSendSessionDisconnected: (...args: unknown[]) => reportSendMock(...args),
}));

const { deliverEvolutionNotification } = await import("./evolutionDelivery");

const MESSAGE = {
  from: null,
  to: "96550000000",
  body: "Receipt attached",
  config: { api_base: "http://evolution:8080", api_key_env: "EVOLUTION_API_KEY" },
};

/** صفّ اتصال نشط لطريقة QR. */
function qrConnection(overrides: Partial<ConnectionRow> = {}): ConnectionRow {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    company_id: COMPANY_ID,
    method: "evolution_qr",
    is_active: true,
    status: "connected",
    instance_name: "ijary-11111111111111114111111111111111",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.connections = [qrConnection()];
  state.updates = [];
  state.ingested = [];
  reportSendMock.mockResolvedValue(undefined);
  vi.stubEnv("EVOLUTION_API_KEY", "evo-key");
  // The live probe is the one call that leaves the process; the gateway
  // answers "not open", so the row decides the outcome.
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ instance: { state: "close" } }), { status: 200 }),
      ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("deliverEvolutionNotification session disconnect reporting", () => {
  test("21: session_disconnected triggers reportSendSessionDisconnected and rethrows the exact error", async () => {
    const err = new EvolutionProviderError("Session disconnected", "session_disconnected", false);
    sendWithEvolutionMock.mockRejectedValueOnce(err);

    await expect(deliverEvolutionNotification(MESSAGE)).rejects.toBe(err);
    expect(reportSendMock).toHaveBeenCalledTimes(1);
  });

  test("22: instance_missing triggers reportSendSessionDisconnected", async () => {
    const err = new EvolutionProviderError("Instance missing", "instance_missing", false);
    sendWithEvolutionMock.mockRejectedValueOnce(err);

    await expect(deliverEvolutionNotification(MESSAGE)).rejects.toMatchObject({
      code: "instance_missing",
    });
    expect(reportSendMock).toHaveBeenCalledTimes(1);
  });

  test("23: reportSendSessionDisconnected throwing still rethrows the original EvolutionProviderError", async () => {
    const err = new EvolutionProviderError("Session disconnected", "session_disconnected", false);
    sendWithEvolutionMock.mockRejectedValueOnce(err);
    reportSendMock.mockRejectedValueOnce(new Error("watcher crashed"));

    await expect(deliverEvolutionNotification(MESSAGE)).rejects.toBe(err);
  });

  test("24: number_not_on_whatsapp does not call reportSendSessionDisconnected", async () => {
    const err = new EvolutionProviderError("Not on WhatsApp", "number_not_on_whatsapp", false);
    sendWithEvolutionMock.mockRejectedValueOnce(err);

    await expect(deliverEvolutionNotification(MESSAGE)).rejects.toBe(err);
    expect(reportSendMock).not.toHaveBeenCalled();
  });
});

describe("deliverEvolutionNotification connection source", () => {
  test("sends through the company's own active QR connection", async () => {
    sendWithEvolutionMock.mockResolvedValueOnce({ messageId: "evo-1", partIds: ["evo-1"] });

    const result = await deliverEvolutionNotification(MESSAGE);

    expect(sendWithEvolutionMock).toHaveBeenCalledTimes(1);
    // The instance name is the row's own, never a literal that could point at
    // another company's session on the shared Evolution server.
    expect(sendWithEvolutionMock.mock.calls[0][1]).toBe("ijary-11111111111111114111111111111111");
    expect(result).toEqual({ messageId: "evo-1" });
  });

  test("refuses to send when the company has no active connection", async () => {
    state.connections = [];

    await expect(deliverEvolutionNotification(MESSAGE)).rejects.toMatchObject({
      code: "session_disconnected",
    });

    expect(sendWithEvolutionMock).not.toHaveBeenCalled();
  });

  test("never sends through another company's connection", async () => {
    state.connections = [qrConnection({ company_id: OTHER_COMPANY_ID })];

    await expect(deliverEvolutionNotification(MESSAGE)).rejects.toMatchObject({
      code: "session_disconnected",
    });

    expect(sendWithEvolutionMock).not.toHaveBeenCalled();
  });

  test("refuses to send while the connection is not connected", async () => {
    state.connections = [qrConnection({ status: "disconnected" })];

    await expect(deliverEvolutionNotification(MESSAGE)).rejects.toMatchObject({
      code: "session_disconnected",
    });

    expect(sendWithEvolutionMock).not.toHaveBeenCalled();
  });
});
