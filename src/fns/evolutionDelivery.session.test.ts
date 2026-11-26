import { beforeEach, describe, expect, test, vi } from "vitest";

import { EvolutionProviderError } from "@/lib/providers/evolution";

const state = {
  connectionRow: { instance_name: "danat", last_connection_state: "open" } as {
    instance_name: string;
    last_connection_state: string | null;
  } | null,
};

const sendWithEvolutionMock = vi.fn();
const reportSendMock = vi.fn();

vi.mock("@/company/companyClient.server", () => ({
  serverCompanyClient: () => ({
    companyId: "11111111-1111-4111-8111-111111111111",
    client: {
      from: (table: string) => {
        if (table === "evolution_connections") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: state.connectionRow, error: null }),
              }),
            }),
            update: () => ({
              eq: async () => ({ data: null, error: null }),
            }),
          };
        }
        throw new Error(`Unexpected table: ${table}`);
      },
    },
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
  config: { api_base: "https://evo.example.test", api_key_env: "EVO_KEY" },
};

beforeEach(() => {
  vi.clearAllMocks();
  state.connectionRow = { instance_name: "danat", last_connection_state: "open" };
  reportSendMock.mockResolvedValue(undefined);
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
