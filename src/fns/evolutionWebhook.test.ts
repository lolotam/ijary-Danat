import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: vi.fn().mockReturnValue({
    middleware: vi.fn().mockReturnThis(),
    validator: vi.fn().mockReturnThis(),
    handler: vi.fn().mockReturnThis(),
  }),
  createMiddleware: vi.fn().mockReturnValue({ server: vi.fn() }),
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: vi.fn() }));
const confirmSessionDisconnectMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/fns/evolutionSessionWatch", () => ({
  confirmSessionDisconnect: (...args: unknown[]) => confirmSessionDisconnectMock(...args),
}));

const db = {
  connection: null as Record<string, unknown> | null,
  connectionError: null as { message: string } | null,
  updates: [] as Record<string, unknown>[],
  /** Every update with the table it targeted and the filters it carried. */
  tableUpdates: [] as {
    table: string;
    values: Record<string, unknown>;
    filters: Array<[string, string, string]>;
  }[],
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  rpcError: null as { message: string } | null,
};

vi.mock("@/integrations/supabase/client.server", () => {
  function builder(table: string) {
    const chain: any = {
      _values: null as Record<string, unknown> | null,
      _filters: [] as Array<[string, string, string]>,
      select: () => chain,
      eq: (column: string, value: string) => {
        chain._filters.push(["eq", column, value]);
        return chain;
      },
      like: (column: string, value: string) => {
        chain._filters.push(["like", column, value]);
        return chain;
      },
      maybeSingle: () => Promise.resolve({ data: db.connection, error: db.connectionError }),
      update(values: Record<string, unknown>) {
        chain._values = values;
        return chain;
      },
      then: (onFulfilled: (value: unknown) => unknown) => {
        if (chain._values) {
          db.updates.push(chain._values);
          db.tableUpdates.push({ table, values: chain._values, filters: chain._filters });
        }
        return Promise.resolve({ data: null, error: null }).then(onFulfilled);
      },
    };
    return chain;
  }
  return {
    supabaseAdmin: {
      from: (table: string) => builder(table),
      rpc: (name: string, args: Record<string, unknown>) => {
        db.rpcCalls.push({ name, args });
        return Promise.resolve({ data: 1, error: db.rpcError });
      },
    },
  };
});

import { respondToEvolutionWebhook } from "./evolutionWebhook";

const SECRET = "current-secret";

function webhookRequest(body: unknown, overrides: RequestInit = {}): Request {
  return new Request("https://danat-future.com/api/public/evolution-webhook", {
    method: "POST",
    headers: { "x-danat-webhook-secret": SECRET, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...overrides,
  });
}

function messageEvent(items: unknown): Record<string, unknown> {
  return { event: "messages.upsert", instance: "danat", data: items };
}

describe("respondToEvolutionWebhook", () => {
  beforeEach(() => {
    db.connection = {
      instance_name: "danat",
      webhook_secret: SECRET,
      previous_webhook_secret: "old-secret",
    };
    db.connectionError = null;
    db.updates = [];
    db.tableUpdates = [];
    db.rpcCalls = [];
    db.rpcError = null;
    confirmSessionDisconnectMock.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("rejects non-POST methods", async () => {
    const response = await respondToEvolutionWebhook(
      new Request("https://x.test/", { method: "GET" }),
    );
    expect(response.status).toBe(405);
  });

  it("rejects unparseable bodies without touching the database", async () => {
    const response = await respondToEvolutionWebhook(webhookRequest("{not json"));
    expect(response.status).toBe(400);
    expect(db.rpcCalls).toEqual([]);
  });

  it("rejects an oversized body before parsing it", async () => {
    const response = await respondToEvolutionWebhook(webhookRequest("x".repeat(1024 * 1024 + 1)));
    expect(response.status).toBe(413);
  });

  it("rejects a wrong secret with 401 and ingests nothing", async () => {
    const response = await respondToEvolutionWebhook(
      webhookRequest(messageEvent([]), {
        headers: { "x-danat-webhook-secret": "wrong", "Content-Type": "application/json" },
      }),
    );
    expect(response.status).toBe(401);
    expect(db.rpcCalls).toEqual([]);
  });

  it("accepts the previous secret during rotation", async () => {
    // beginEvolutionSession configures the new secret on Evolution before
    // persisting it; deliveries signed with the old one must keep landing.
    const response = await respondToEvolutionWebhook(
      webhookRequest(messageEvent([]), {
        headers: { "x-danat-webhook-secret": "old-secret", "Content-Type": "application/json" },
      }),
    );
    expect(response.status).toBe(200);
  });

  it("rejects a payload naming a different instance even with a valid secret", async () => {
    const response = await respondToEvolutionWebhook(
      webhookRequest({ event: "messages.upsert", instance: "intruder", data: [] }),
    );
    expect(response.status).toBe(401);
  });

  it("ingests an inbound message with device-suffix digits and push name", async () => {
    const response = await respondToEvolutionWebhook(
      webhookRequest(
        messageEvent([
          {
            key: { id: "wamid-1", remoteJid: "96550123456:7@s.whatsapp.net", fromMe: false },
            pushName: "أحمد",
            messageTimestamp: 1756720000,
            message: { conversation: "السلام عليكم" },
          },
        ]),
      ),
    );

    expect(response.status).toBe(200);
    expect(db.rpcCalls).toHaveLength(1);
    expect(db.rpcCalls[0].name).toBe("ingest_whatsapp_messages");
    const rows = db.rpcCalls[0].args.p_rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      message_id: "wamid-1",
      chat_number: "96550123456",
      direction: "inbound",
      from_me: false,
      body: "السلام عليكم",
      message_type: "text",
      push_name: "أحمد",
    });
  });

  it("marks fromMe echoes outbound and never credits their push name", async () => {
    await respondToEvolutionWebhook(
      webhookRequest(
        messageEvent({
          key: { id: "wamid-2", remoteJid: "96550123456@s.whatsapp.net", fromMe: true },
          pushName: "Danat",
          message: { conversation: "receipt" },
        }),
      ),
    );

    const rows = db.rpcCalls[0].args.p_rows as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ direction: "outbound", from_me: true, push_name: null });
  });

  it("resolves @lid ids via remoteJidAlt and drops unresolved ones and groups", async () => {
    await respondToEvolutionWebhook(
      webhookRequest(
        messageEvent([
          {
            key: {
              id: "lid-ok",
              remoteJid: "9999@lid",
              remoteJidAlt: "96599887766@s.whatsapp.net",
            },
            message: { conversation: "hi" },
          },
          { key: { id: "lid-bad", remoteJid: "8888@lid" }, message: { conversation: "hi" } },
          { key: { id: "group-1", remoteJid: "12345@g.us" }, message: { conversation: "hi" } },
        ]),
      ),
    );

    const rows = db.rpcCalls[0].args.p_rows as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.message_id)).toEqual(["lid-ok"]);
    expect(rows[0].chat_number).toBe("96599887766");
  });

  it("stores document media with its filename and an allow-listed raw subset", async () => {
    await respondToEvolutionWebhook(
      webhookRequest(
        messageEvent({
          key: { id: "wamid-3", remoteJid: "96550123456@s.whatsapp.net", fromMe: false },
          message: { documentMessage: { fileName: "contract.pdf", caption: "العقد" } },
        }),
      ),
    );

    const rows = db.rpcCalls[0].args.p_rows as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({
      body: "العقد",
      message_type: "document",
      media_type: "document",
      media_id: "wamid-3",
      media_filename: "contract.pdf",
    });
    // raw must stay a diagnostic subset — never the payload (it can embed base64).
    expect(Object.keys(rows[0].raw as Record<string, unknown>).sort()).toEqual([
      "key",
      "messageTimestamp",
    ]);
  });

  it("answers 500 when ingestion fails so Evolution redelivers", async () => {
    db.rpcError = { message: "storage down" };
    const response = await respondToEvolutionWebhook(
      webhookRequest(
        messageEvent({
          key: { id: "wamid-4", remoteJid: "96550123456@s.whatsapp.net" },
          message: { conversation: "hi" },
        }),
      ),
    );
    expect(response.status).toBe(500);
  });

  it("updates the connection state and clears the QR when the session opens", async () => {
    const response = await respondToEvolutionWebhook(
      webhookRequest({ event: "connection.update", instance: "danat", data: { state: "OPEN" } }),
    );

    expect(response.status).toBe(200);
    expect(db.updates).toEqual([{ last_connection_state: "open", last_qr: null }]);
  });

  it("stores a pushed QR refresh as connecting", async () => {
    await respondToEvolutionWebhook(
      webhookRequest({
        event: "qrcode.updated",
        instance: "danat",
        data: { qrcode: { base64: "QR-DATA" } },
      }),
    );

    expect(db.updates).toEqual([{ last_qr: "QR-DATA", last_connection_state: "connecting" }]);
  });

  describe("server acks on our own sends (messages.update)", () => {
    it.each([
      {
        shape: "Evolution v2.3.7 mapped payload",
        data: { keyId: "3EB07B12142F92CA1C6673", fromMe: true, status: "ERROR" },
      },
      {
        shape: "raw Baileys array payload",
        data: [
          {
            key: { id: "3EB07B12142F92CA1C6673", fromMe: true },
            update: { status: 0, messageStubParameters: ["463"] },
          },
        ],
      },
    ])("parks a sent notification WhatsApp later rejected — $shape", async ({ data }) => {
      // 2026-09-02 01:15: the overdue reminder to one tenant was recorded
      // `sent` in the log and the inbox; WhatsApp's ack was error 463 and
      // nothing ever changed either row.
      const response = await respondToEvolutionWebhook(
        webhookRequest({ event: "messages.update", instance: "danat", data }),
      );

      expect(response.status).toBe(200);
      expect(db.tableUpdates).toEqual([
        {
          table: "whatsapp_messages",
          values: { status: "failed" },
          filters: [["eq", "message_id", "3EB07B12142F92CA1C6673"]],
        },
        {
          table: "notifications",
          values: {
            state: "needs_review",
            error_code: "whatsapp_rejected",
            failure_reason: expect.stringMatching(/463/),
          },
          filters: [
            ["eq", "state", "sent"],
            ["like", "provider_message_id", "%3EB07B12142F92CA1C6673%"],
          ],
        },
      ]);
    });

    it("records a delivery ack on the inbox row and leaves the notification alone", async () => {
      await respondToEvolutionWebhook(
        webhookRequest({
          event: "messages.update",
          instance: "danat",
          data: { keyId: "3EB07B12142F92CA1C6673", fromMe: true, status: "DELIVERY_ACK" },
        }),
      );

      expect(db.tableUpdates.map((u) => [u.table, u.values])).toEqual([
        ["whatsapp_messages", { status: "delivered" }],
      ]);
    });

    it("ignores acks on inbound messages and non-final states", async () => {
      await respondToEvolutionWebhook(
        webhookRequest({
          event: "messages.update",
          instance: "danat",
          data: [
            { keyId: "3A3A472894E5D93589A2", fromMe: false, status: "READ" },
            { keyId: "3EB07B12142F92CA1C6673", fromMe: true, status: "SERVER_ACK" },
            { keyId: "../not-an-id", fromMe: true, status: "ERROR" },
          ],
        }),
      );

      expect(db.tableUpdates).toEqual([]);
    });
  });

  it("acknowledges unhandled events without touching storage", async () => {
    const response = await respondToEvolutionWebhook(
      webhookRequest({ event: "presence.update", instance: "danat", data: {} }),
    );
    expect(response.status).toBe(200);
    expect(db.updates).toEqual([]);
    expect(db.rpcCalls).toEqual([]);
  });

  describe("disconnect confirmation trigger on connection.update", () => {
    it("17: close answers 200 and triggers confirmSessionDisconnect", async () => {
      const response = await respondToEvolutionWebhook(
        webhookRequest({ event: "connection.update", instance: "danat", data: { state: "close" } }),
      );

      expect(response.status).toBe(200);
      expect(confirmSessionDisconnectMock).toHaveBeenCalledTimes(1);
    });

    it("18: refused triggers confirmSessionDisconnect", async () => {
      const response = await respondToEvolutionWebhook(
        webhookRequest({
          event: "connection.update",
          instance: "danat",
          data: { state: "refused" },
        }),
      );

      expect(response.status).toBe(200);
      expect(confirmSessionDisconnectMock).toHaveBeenCalledTimes(1);
    });

    it("19: connecting and open do not trigger confirmSessionDisconnect", async () => {
      await respondToEvolutionWebhook(
        webhookRequest({
          event: "connection.update",
          instance: "danat",
          data: { state: "connecting" },
        }),
      );
      await respondToEvolutionWebhook(
        webhookRequest({ event: "connection.update", instance: "danat", data: { state: "open" } }),
      );

      expect(confirmSessionDisconnectMock).not.toHaveBeenCalled();
    });

    it("20: confirmSessionDisconnect rejecting still returns 200 with no unhandled rejection", async () => {
      confirmSessionDisconnectMock.mockRejectedValueOnce(new Error("probe failed"));

      const response = await respondToEvolutionWebhook(
        webhookRequest({ event: "connection.update", instance: "danat", data: { state: "close" } }),
      );
      await Promise.resolve();

      expect(response.status).toBe(200);
      expect(confirmSessionDisconnectMock).toHaveBeenCalledTimes(1);
    });
  });
});
