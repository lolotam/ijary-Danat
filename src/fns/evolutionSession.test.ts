import { beforeEach, describe, expect, test, vi } from "vitest";

const callOrder: string[] = [];
const state = {
  disarmError: null as { message: string } | null,
  connectionRow: {
    id: 1,
    instance_name: "danat",
    webhook_secret: "sec",
    previous_webhook_secret: null,
    connected_number: "96550000000",
    last_connection_state: "open",
    last_qr: null,
    connected_at: "2026-11-01T00:00:00Z",
    disconnect_alert_armed: true,
    disconnected_at: null,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
  },
  updates: [] as Array<Record<string, unknown>>,
};

const logoutMock = vi.fn();
const deleteInstanceMock = vi.fn();

vi.mock("@tanstack/react-start", () => {
  const fn: any = (data: any) => fn._handler({ data, context: fn._context });
  fn.middleware = vi.fn().mockReturnValue(fn);
  fn.validator = vi.fn().mockReturnValue(fn);
  fn.inputValidator = vi.fn().mockReturnValue(fn);
  fn.handler = vi.fn().mockImplementation((h: any) => {
    fn._handler = h;
    return fn;
  });
  return { createServerFn: vi.fn().mockReturnValue(fn) };
});

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: vi.fn() }));
vi.mock("@/fns/requirePermission", () => ({ requirePermission: vi.fn() }));

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
      if (table === "evolution_connections") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: state.connectionRow, error: null }),
            }),
          }),
          update: (values: Record<string, unknown>) => ({
            eq: async () => {
              state.updates.push(values);
              if (values.last_connection_state === "disconnecting") {
                callOrder.push("disarm");
                if (state.disarmError) return { data: null, error: state.disarmError };
              } else {
                callOrder.push("final_update");
              }
              return { data: null, error: null };
            },
          }),
        };
      }
      if (table === "provider_configs") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: "prov-1",
                  provider: "evolution_api",
                  is_enabled: true,
                  config: { api_base: "https://evo.example.test", api_key_env: "EVO_KEY" },
                },
                error: null,
              }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  }),
}));

vi.mock("@/lib/providers/evolution", () => ({
  connectedNumberFor: vi.fn(),
  evolutionClientFromConfig: () => ({
    logout: async (...args: unknown[]) => {
      callOrder.push("logout");
      return logoutMock(...args);
    },
    deleteInstance: async (...args: unknown[]) => {
      callOrder.push("deleteInstance");
      return deleteInstanceMock(...args);
    },
  }),
}));

const { disconnectEvolutionSession } = await import("./evolutionSession");

beforeEach(() => {
  vi.clearAllMocks();
  callOrder.length = 0;
  state.disarmError = null;
  state.updates = [];
  logoutMock.mockResolvedValue(undefined);
  deleteInstanceMock.mockResolvedValue(undefined);
});

describe("disconnectEvolutionSession intentional disarm", () => {
  test("25: disarms and sets last_connection_state=disconnecting BEFORE client.logout", async () => {
    const result = await disconnectEvolutionSession();

    expect(result).toEqual({ disconnected: true, state: "close" });
    expect(callOrder).toEqual(["disarm", "logout", "deleteInstance", "final_update"]);
    expect(state.updates[0]).toEqual({
      disconnect_alert_armed: false,
      last_connection_state: "disconnecting",
    });
    expect(state.updates[1]).toEqual({
      disconnect_alert_armed: false,
      last_connection_state: "close",
      last_qr: null,
      connected_number: null,
      connected_at: null,
    });
  });

  test("26: disarm update failure throws and never calls client.logout", async () => {
    state.disarmError = { message: "db write failed" };

    await expect(disconnectEvolutionSession()).rejects.toThrow("db write failed");
    expect(logoutMock).not.toHaveBeenCalled();
    expect(deleteInstanceMock).not.toHaveBeenCalled();
  });
});
