import { beforeEach, describe, expect, test, vi } from "vitest";

import { EvolutionApiError } from "@/lib/evolution/client";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "00000000-0000-4000-8000-000000000001";
const INSTANCE_NAME = "ijary-00000000000040008000000000000001";

const state = {
  connectionRow: {
    instance_name: INSTANCE_NAME,
    disconnect_alert_armed: true,
    status: "disconnected" as string | null,
  } as {
    instance_name: string;
    disconnect_alert_armed: boolean;
    status: string | null;
  } | null,
  /** صفّ الاتصال النشط بطريقة QR كما يقرؤه مسار الإرسال. */
  activeConnection: { id: CONNECTION_ID } as { id: string } | null,
  providerRow: {
    is_enabled: true,
    config: { api_base: "https://evo.example.test", api_key_env: "EVO_KEY" },
  } as { is_enabled: boolean; config: Record<string, unknown> } | null,
  connectionUpdates: [] as Array<Record<string, unknown>>,
  connectionUpdateCalls: [] as Array<{
    values: Record<string, unknown>;
    filters: Array<[string, ...unknown[]]>;
  }>,
  connectionReadError: null as { message: string } | null,
  providerReadError: null as { message: string } | null,
  updateError: null as { message: string } | null,
};

const connectionStateMock = vi.fn();
const notifyDisconnectedMock = vi.fn();

const TEST_COMPANY = {
  id: COMPANY_ID,
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
      if (table === "whatsapp_connections") {
        const chain: any = {
          _update: null as Record<string, unknown> | null,
          _filters: [] as Array<[string, ...unknown[]]>,
          select: () => chain,
          eq: (col: string, val: unknown) => {
            chain._filters.push(["eq", col, val]);
            return chain;
          },
          neq: (col: string, val: unknown) => {
            chain._filters.push(["neq", col, val]);
            return chain;
          },
          or: (expr: string) => {
            chain._filters.push(["or", expr]);
            return chain;
          },
          maybeSingle: async () => {
            const byId = chain._filters.some(
              (filter: [string, ...unknown[]]) =>
                filter[0] === "eq" && filter[1] === "id" && filter[2] === CONNECTION_ID,
            );
            return {
              data: byId ? state.connectionRow : state.activeConnection,
              error: state.connectionReadError,
            };
          },
          update(values: Record<string, unknown>) {
            chain._update = values;
            chain._filters = [];
            state.connectionUpdates.push(values);
            return chain;
          },
          then: (onFulfilled: (value: unknown) => unknown) => {
            if (chain._update) {
              state.connectionUpdateCalls.push({
                values: chain._update,
                filters: [...chain._filters],
              });
            }
            return Promise.resolve({ data: null, error: state.updateError }).then(onFulfilled);
          },
        };
        return chain;
      }
      if (table === "provider_configs") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: state.providerRow,
                error: state.providerReadError,
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
  evolutionClientFromConfig: () => ({
    connectionState: (...args: unknown[]) => connectionStateMock(...args),
  }),
}));

vi.mock("@/fns/notifyWhatsappSessionDisconnected", () => ({
  notifyWhatsappSessionDisconnected: (...args: unknown[]) => notifyDisconnectedMock(...args),
}));

const { confirmSessionDisconnect, reportSendSessionDisconnected } =
  await import("./evolutionSessionWatch");

/** الجلسة التي تُراقَب: شركة واحدة واتصال واحد. */
const TARGET = { companyId: COMPANY_ID, connectionId: CONNECTION_ID };

beforeEach(() => {
  vi.clearAllMocks();
  state.connectionRow = {
    instance_name: INSTANCE_NAME,
    disconnect_alert_armed: true,
    status: "disconnected",
  };
  state.activeConnection = { id: CONNECTION_ID };
  state.providerRow = {
    is_enabled: true,
    config: { api_base: "https://evo.example.test", api_key_env: "EVO_KEY" },
  };
  state.connectionUpdates = [];
  state.connectionUpdateCalls = [];
  state.connectionReadError = null;
  state.providerReadError = null;
  state.updateError = null;
  notifyDisconnectedMock.mockResolvedValue({ skipped: false });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("confirmSessionDisconnect", () => {
  test("10: connected or unarmed row skips live probe and sender", async () => {
    state.connectionRow = {
      instance_name: INSTANCE_NAME,
      disconnect_alert_armed: true,
      status: "connected",
    };
    await confirmSessionDisconnect(TARGET);
    expect(connectionStateMock).not.toHaveBeenCalled();
    expect(notifyDisconnectedMock).not.toHaveBeenCalled();

    state.connectionRow = {
      instance_name: INSTANCE_NAME,
      disconnect_alert_armed: false,
      status: "disconnected",
    };
    await confirmSessionDisconnect(TARGET);
    expect(connectionStateMock).not.toHaveBeenCalled();
    expect(notifyDisconnectedMock).not.toHaveBeenCalled();
  });

  test("11: live probe returning open heals the row and does not notify", async () => {
    connectionStateMock.mockResolvedValueOnce({ instance: { state: "open" } });

    await confirmSessionDisconnect(TARGET);

    expect(state.connectionUpdateCalls).toEqual([
      {
        values: {
          status: "connected",
          last_seen_at: expect.any(String),
          disconnected_at: null,
          disconnect_alert_armed: true,
        },
        filters: [
          ["eq", "id", CONNECTION_ID],
          ["or", "connected_number.not.is.null,connected_at.not.is.null"],
        ],
      },
    ]);
    expect(notifyDisconnectedMock).not.toHaveBeenCalled();
  });

  test("12: live probe failing with gateway/network error does not notify", async () => {
    connectionStateMock.mockRejectedValueOnce(new EvolutionApiError("timeout", 0, null));

    await confirmSessionDisconnect(TARGET);

    expect(notifyDisconnectedMock).not.toHaveBeenCalled();
  });

  test("13: live probe returning close calls sender once with source webhook", async () => {
    connectionStateMock.mockResolvedValueOnce({ instance: { state: "close" } });

    await confirmSessionDisconnect(TARGET);

    expect(notifyDisconnectedMock).toHaveBeenCalledTimes(1);
    expect(notifyDisconnectedMock).toHaveBeenCalledWith({ source: "webhook", ...TARGET });
  });

  test("14: live probe returning connecting calls sender (confirmed not open)", async () => {
    connectionStateMock.mockResolvedValueOnce({ instance: { state: "connecting" } });

    await confirmSessionDisconnect(TARGET);

    expect(notifyDisconnectedMock).toHaveBeenCalledTimes(1);
    expect(notifyDisconnectedMock).toHaveBeenCalledWith({ source: "webhook", ...TARGET });
  });

  test("15: live probe returning HTTP 404 treats deleted instance as confirmed disconnect", async () => {
    connectionStateMock.mockRejectedValueOnce(
      new EvolutionApiError("Evolution API request failed with status 404", 404, {}),
    );

    await confirmSessionDisconnect(TARGET);

    expect(notifyDisconnectedMock).toHaveBeenCalledTimes(1);
    expect(notifyDisconnectedMock).toHaveBeenCalledWith({ source: "webhook", ...TARGET });
  });

  test("16: sender throwing never rejects confirmSessionDisconnect", async () => {
    connectionStateMock.mockResolvedValueOnce({ instance: { state: "close" } });
    notifyDisconnectedMock.mockRejectedValueOnce(new Error("boom"));

    await expect(confirmSessionDisconnect(TARGET)).resolves.toBeUndefined();
  });

  test("16b: logs DB read errors and reportable sender skips, stays quiet on benign skips", async () => {
    state.connectionReadError = { message: "conn read failed" };
    await confirmSessionDisconnect(TARGET);
    expect(console.error).toHaveBeenCalledWith(
      "[evolutionSessionWatch] failed to read connection row",
      "conn read failed",
    );

    vi.mocked(console.error).mockClear();
    state.connectionReadError = null;
    state.providerReadError = { message: "provider read failed" };
    await confirmSessionDisconnect(TARGET);
    expect(console.error).toHaveBeenCalledWith(
      "[evolutionSessionWatch] failed to read provider config",
      "provider read failed",
    );

    vi.mocked(console.error).mockClear();
    state.providerReadError = null;
    connectionStateMock.mockResolvedValueOnce({ instance: { state: "close" } });
    notifyDisconnectedMock.mockResolvedValueOnce({
      skipped: true,
      reason: "No admin email recipients configured.",
    });
    await confirmSessionDisconnect(TARGET);
    expect(console.error).toHaveBeenCalledWith(
      "[evolutionSessionWatch] disconnect alert skipped (webhook):",
      "No admin email recipients configured.",
    );

    vi.mocked(console.error).mockClear();
    connectionStateMock.mockResolvedValueOnce({ instance: { state: "close" } });
    notifyDisconnectedMock.mockResolvedValueOnce({
      skipped: true,
      reason: "Already alerted for this outage.",
      benign: true,
    });
    await confirmSessionDisconnect(TARGET);
    expect(console.error).not.toHaveBeenCalled();
  });

  test("17: a connection without an instance name is never probed", async () => {
    state.connectionRow = {
      instance_name: "",
      disconnect_alert_armed: true,
      status: "disconnected",
    };

    await confirmSessionDisconnect(TARGET);

    expect(connectionStateMock).not.toHaveBeenCalled();
    expect(notifyDisconnectedMock).not.toHaveBeenCalled();
  });
});

describe("reportSendSessionDisconnected", () => {
  test("marks the connected row disconnected and invokes sender with source send", async () => {
    await reportSendSessionDisconnected();

    expect(state.connectionUpdateCalls).toEqual([
      {
        values: { status: "disconnected", disconnected_at: expect.any(String) },
        filters: [
          ["eq", "id", CONNECTION_ID],
          ["eq", "status", "connected"],
        ],
      },
    ]);
    expect(notifyDisconnectedMock).toHaveBeenCalledTimes(1);
    expect(notifyDisconnectedMock).toHaveBeenCalledWith({ source: "send", ...TARGET });
  });

  test("still invokes sender when the conditional close update returns an error", async () => {
    state.updateError = { message: "db hiccup" };

    await reportSendSessionDisconnected();

    expect(notifyDisconnectedMock).toHaveBeenCalledTimes(1);
    expect(notifyDisconnectedMock).toHaveBeenCalledWith({ source: "send", ...TARGET });
  });

  test("never rejects when the sender throws", async () => {
    notifyDisconnectedMock.mockRejectedValueOnce(new Error("boom"));

    await expect(reportSendSessionDisconnected()).resolves.toBeUndefined();
  });

  test("a company with no active QR connection has nothing to report", async () => {
    state.activeConnection = null;

    await reportSendSessionDisconnected();

    expect(state.connectionUpdateCalls).toEqual([]);
    expect(notifyDisconnectedMock).not.toHaveBeenCalled();
  });
});
