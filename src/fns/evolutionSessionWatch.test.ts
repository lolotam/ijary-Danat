import { beforeEach, describe, expect, test, vi } from "vitest";

import { EvolutionApiError } from "@/lib/evolution/client";

const state = {
  connectionRow: {
    instance_name: "danat",
    disconnect_alert_armed: true,
    last_connection_state: "close" as string | null,
  } as {
    instance_name: string;
    disconnect_alert_armed: boolean;
    last_connection_state: string | null;
  } | null,
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

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "evolution_connections") {
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
          maybeSingle: async () => ({
            data: state.connectionRow,
            error: state.connectionReadError,
          }),
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
  },
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

beforeEach(() => {
  vi.clearAllMocks();
  state.connectionRow = {
    instance_name: "danat",
    disconnect_alert_armed: true,
    last_connection_state: "close",
  };
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
  test("10: open or unarmed row skips live probe and sender", async () => {
    state.connectionRow = {
      instance_name: "danat",
      disconnect_alert_armed: true,
      last_connection_state: "open",
    };
    await confirmSessionDisconnect();
    expect(connectionStateMock).not.toHaveBeenCalled();
    expect(notifyDisconnectedMock).not.toHaveBeenCalled();

    state.connectionRow = {
      instance_name: "danat",
      disconnect_alert_armed: false,
      last_connection_state: "close",
    };
    await confirmSessionDisconnect();
    expect(connectionStateMock).not.toHaveBeenCalled();
    expect(notifyDisconnectedMock).not.toHaveBeenCalled();
  });

  test("11: live probe returning open heals the row (excluding disconnecting/unpaired) and does not notify", async () => {
    connectionStateMock.mockResolvedValueOnce({ instance: { state: "open" } });

    await confirmSessionDisconnect();

    expect(state.connectionUpdateCalls).toEqual([
      {
        values: { last_connection_state: "open" },
        filters: [
          ["eq", "id", 1],
          ["neq", "last_connection_state", "disconnecting"],
          ["or", "connected_number.not.is.null,connected_at.not.is.null"],
        ],
      },
    ]);
    expect(notifyDisconnectedMock).not.toHaveBeenCalled();
  });

  test("12: live probe failing with gateway/network error does not notify", async () => {
    connectionStateMock.mockRejectedValueOnce(new EvolutionApiError("timeout", 0, null));

    await confirmSessionDisconnect();

    expect(notifyDisconnectedMock).not.toHaveBeenCalled();
  });

  test("13: live probe returning close calls sender once with source webhook", async () => {
    connectionStateMock.mockResolvedValueOnce({ instance: { state: "close" } });

    await confirmSessionDisconnect();

    expect(notifyDisconnectedMock).toHaveBeenCalledTimes(1);
    expect(notifyDisconnectedMock).toHaveBeenCalledWith({ source: "webhook" });
  });

  test("14: live probe returning connecting calls sender (confirmed not open)", async () => {
    connectionStateMock.mockResolvedValueOnce({ instance: { state: "connecting" } });

    await confirmSessionDisconnect();

    expect(notifyDisconnectedMock).toHaveBeenCalledTimes(1);
    expect(notifyDisconnectedMock).toHaveBeenCalledWith({ source: "webhook" });
  });

  test("15: live probe returning HTTP 404 treats deleted instance as confirmed disconnect", async () => {
    connectionStateMock.mockRejectedValueOnce(
      new EvolutionApiError("Evolution API request failed with status 404", 404, {}),
    );

    await confirmSessionDisconnect();

    expect(notifyDisconnectedMock).toHaveBeenCalledTimes(1);
    expect(notifyDisconnectedMock).toHaveBeenCalledWith({ source: "webhook" });
  });

  test("16: sender throwing never rejects confirmSessionDisconnect", async () => {
    connectionStateMock.mockResolvedValueOnce({ instance: { state: "close" } });
    notifyDisconnectedMock.mockRejectedValueOnce(new Error("boom"));

    await expect(confirmSessionDisconnect()).resolves.toBeUndefined();
  });

  test("16b: logs DB read errors and reportable sender skips, stays quiet on benign skips", async () => {
    state.connectionReadError = { message: "conn read failed" };
    await confirmSessionDisconnect();
    expect(console.error).toHaveBeenCalledWith(
      "[evolutionSessionWatch] failed to read connection row",
      "conn read failed",
    );

    vi.mocked(console.error).mockClear();
    state.connectionReadError = null;
    state.providerReadError = { message: "provider read failed" };
    await confirmSessionDisconnect();
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
    await confirmSessionDisconnect();
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
    await confirmSessionDisconnect();
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("reportSendSessionDisconnected", () => {
  test("marks open row close conditionally and invokes sender with source send", async () => {
    await reportSendSessionDisconnected();

    expect(state.connectionUpdateCalls).toEqual([
      {
        values: { last_connection_state: "close" },
        filters: [
          ["eq", "id", 1],
          ["eq", "last_connection_state", "open"],
        ],
      },
    ]);
    expect(notifyDisconnectedMock).toHaveBeenCalledTimes(1);
    expect(notifyDisconnectedMock).toHaveBeenCalledWith({ source: "send" });
  });

  test("still invokes sender when the conditional close update returns an error", async () => {
    state.updateError = { message: "db hiccup" };

    await reportSendSessionDisconnected();

    expect(notifyDisconnectedMock).toHaveBeenCalledTimes(1);
    expect(notifyDisconnectedMock).toHaveBeenCalledWith({ source: "send" });
  });

  test("never rejects when the sender throws", async () => {
    notifyDisconnectedMock.mockRejectedValueOnce(new Error("boom"));

    await expect(reportSendSessionDisconnected()).resolves.toBeUndefined();
  });
});
