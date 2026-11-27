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

// The webhook secret is decrypted for real, so the test needs a master key and
// the same encrypt/bytea helpers the pairing path uses.
process.env.INTEGRATIONS_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");

import { encodeByteaHex } from "@/gateways/connectionStore.server";
import { encryptSecret } from "@/lib/secrets.server";

const db = {
  /** صفّ المالك كما تجيب عنه دالة قاعدة البيانات. */
  connection: null as Record<string, unknown> | null,
  connectionError: null as { message: string } | null,
  /** إصدارات سرّ الويبهوك، الأحدث أولاً. */
  secretRows: [] as Record<string, unknown>[],
  secretError: null as { message: string } | null,
  updates: [] as Record<string, unknown>[],
  /** Every update with the table it targeted and the filters it carried. */
  tableUpdates: [] as {
    table: string;
    values: Record<string, unknown>;
    filters: Array<[string, string, string]>;
  }[],
  /** استدعاءات دالة ابتلاع الرسائل. */
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
  /** استدعاءات دالة البحث عن المالك عبر الشركات. */
  lookupCalls: [] as Record<string, unknown>[],
  rpcError: null as { message: string } | null,
};

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";
const TEST_COMPANY_ID = "00000000-0000-4000-8000-000000000001";
const INSTANCE_NAME = "ijary-00000000000040008000000000000001";

const TEST_COMPANY = {
  id: TEST_COMPANY_ID,
  slug: "danat",
  status: "active" as const,
};

vi.mock("@/company/requestCompany.server", () => ({
  getRequestCompany: () => TEST_COMPANY,
  requireRequestCompany: () => TEST_COMPANY,
  runWithRequestCompany: async (_company: unknown, fn: () => unknown) => fn(),
}));

// The owner lookup is the platform's read across companies (a database
// boundary); the stub answers with the fixture connection.
vi.mock("@/platform/whatsappConnectionLookup.server", () => ({
  lookupWhatsappConnectionById: async (connectionId: string) => {
    db.lookupCalls.push({ connectionId });
    if (db.connectionError) {
      throw new Error(`whatsapp connection lookup failed: ${db.connectionError.message}`);
    }
    return db.connection ?? null;
  },
}));

vi.mock("@/company/companyClient.server", () => {
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
      neq: (column: string, value: string) => {
        chain._filters.push(["neq", column, value]);
        return chain;
      },
      order: () => chain,
      limit: () => chain,
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
        if (table === "company_secrets") {
          return Promise.resolve({ data: db.secretRows, error: db.secretError }).then(onFulfilled);
        }
        return Promise.resolve({ data: null, error: null }).then(onFulfilled);
      },
    };
    return chain;
  }
  const client = {
    from: (table: string) => builder(table),
    rpc: (name: string, args: Record<string, unknown>) => {
      db.rpcCalls.push({ name, args });
      return Promise.resolve({ data: 1, error: db.rpcError });
    },
  };
  return {
    companyClient: () => client,
  };
});

import { respondToEvolutionWebhook } from "./evolutionWebhook.server";

const SECRET = "current-secret";
const PREVIOUS_SECRET = "old-secret";

/** يبني صفّ سرّ مشفّر كما تكتبه دالة الاقتران. */
function secretRow(plain: string, version: number): Record<string, unknown> {
  const encrypted = encryptSecret(plain);
  return {
    ciphertext: encodeByteaHex(encrypted.ciphertext),
    iv: encodeByteaHex(encrypted.iv),
    auth_tag: encodeByteaHex(encrypted.authTag),
    key_version: encrypted.keyVersion,
    version,
  };
}

function webhookRequest(body: unknown, overrides: RequestInit = {}): Request {
  return new Request(`https://danat.ijary.app/api/public/webhooks/evolution/${CONNECTION_ID}`, {
    method: "POST",
    headers: { "x-danat-webhook-secret": SECRET, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...overrides,
  });
}

/** يستدعي نقطة الدخول بمعرّف الاتصال الذي في المسار. */
function callWebhook(request: Request): Promise<Response> {
  return respondToEvolutionWebhook(request, CONNECTION_ID);
}

function messageEvent(items: unknown): Record<string, unknown> {
  return { event: "messages.upsert", instance: INSTANCE_NAME, data: items };
}

describe("respondToEvolutionWebhook", () => {
  beforeEach(() => {
    db.connection = {
      id: CONNECTION_ID,
      company_id: TEST_COMPANY_ID,
      method: "evolution_qr",
      is_active: true,
      status: "connected",
      instance_name: INSTANCE_NAME,
    };
    db.connectionError = null;
    db.secretRows = [secretRow(SECRET, 2), secretRow(PREVIOUS_SECRET, 1)];
    db.secretError = null;
    db.updates = [];
    db.tableUpdates = [];
    db.rpcCalls = [];
    db.lookupCalls = [];
    db.rpcError = null;
    confirmSessionDisconnectMock.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("rejects non-POST methods", async () => {
    const response = await callWebhook(new Request("https://x.test/", { method: "GET" }));
    expect(response.status).toBe(405);
  });

  it("rejects unparseable bodies without touching the database", async () => {
    const response = await callWebhook(webhookRequest("{not json"));
    expect(response.status).toBe(400);
    expect(db.rpcCalls).toEqual([]);
  });

  it("rejects an oversized body before parsing it", async () => {
    const response = await callWebhook(webhookRequest("x".repeat(1024 * 1024 + 1)));
    expect(response.status).toBe(413);
  });

  it("rejects a wrong secret with 401 and ingests nothing", async () => {
    const response = await callWebhook(
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
    const response = await callWebhook(
      webhookRequest(messageEvent([]), {
        headers: { "x-danat-webhook-secret": "old-secret", "Content-Type": "application/json" },
      }),
    );
    expect(response.status).toBe(200);
  });

  it("rejects a payload naming a different instance even with a valid secret", async () => {
    const response = await callWebhook(
      webhookRequest({ event: "messages.upsert", instance: "intruder", data: [] }),
    );
    expect(response.status).toBe(401);
  });

  it("ingests an inbound message with device-suffix digits and push name", async () => {
    const response = await callWebhook(
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
    await callWebhook(
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
    await callWebhook(
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
    await callWebhook(
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
    const response = await callWebhook(
      webhookRequest(
        messageEvent({
          key: { id: "wamid-4", remoteJid: "96550123456@s.whatsapp.net" },
          message: { conversation: "hi" },
        }),
      ),
    );
    expect(response.status).toBe(500);
  });

  it("marks the connection connected and re-arms the disconnect alert when the session opens", async () => {
    const response = await callWebhook(
      webhookRequest({
        event: "connection.update",
        instance: INSTANCE_NAME,
        data: { state: "OPEN" },
      }),
    );

    expect(response.status).toBe(200);
    expect(db.updates).toHaveLength(1);
    expect(db.updates[0]).toMatchObject({
      status: "connected",
      disconnected_at: null,
      disconnect_alert_armed: true,
    });
    expect(db.updates[0].last_seen_at).toEqual(expect.any(String));
  });

  it("stores a pushed QR refresh as pairing", async () => {
    await callWebhook(
      webhookRequest({
        event: "qrcode.updated",
        instance: INSTANCE_NAME,
        data: { qrcode: { base64: "QR-DATA" } },
      }),
    );

    expect(db.updates).toEqual([{ last_qr: "QR-DATA", status: "pairing" }]);
    // A late QR must not knock a paired connection back to "pairing".
    expect(db.tableUpdates).toEqual([
      {
        table: "whatsapp_connections",
        values: { last_qr: "QR-DATA", status: "pairing" },
        filters: [
          ["eq", "id", CONNECTION_ID],
          ["neq", "status", "connected"],
        ],
      },
    ]);
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
      const response = await callWebhook(
        webhookRequest({ event: "messages.update", instance: INSTANCE_NAME, data }),
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
      await callWebhook(
        webhookRequest({
          event: "messages.update",
          instance: INSTANCE_NAME,
          data: { keyId: "3EB07B12142F92CA1C6673", fromMe: true, status: "DELIVERY_ACK" },
        }),
      );

      expect(db.tableUpdates.map((u) => [u.table, u.values])).toEqual([
        ["whatsapp_messages", { status: "delivered" }],
      ]);
    });

    it("ignores acks on inbound messages and non-final states", async () => {
      await callWebhook(
        webhookRequest({
          event: "messages.update",
          instance: INSTANCE_NAME,
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
    const response = await callWebhook(
      webhookRequest({ event: "presence.update", instance: INSTANCE_NAME, data: {} }),
    );
    expect(response.status).toBe(200);
    expect(db.updates).toEqual([]);
    expect(db.rpcCalls).toEqual([]);
  });

  describe("disconnect confirmation trigger on connection.update", () => {
    it("17: close answers 200 and triggers confirmSessionDisconnect", async () => {
      const response = await callWebhook(
        webhookRequest({
          event: "connection.update",
          instance: INSTANCE_NAME,
          data: { state: "close" },
        }),
      );

      expect(response.status).toBe(200);
      expect(confirmSessionDisconnectMock).toHaveBeenCalledTimes(1);
    });

    it("18: refused triggers confirmSessionDisconnect", async () => {
      const response = await callWebhook(
        webhookRequest({
          event: "connection.update",
          instance: INSTANCE_NAME,
          data: { state: "refused" },
        }),
      );

      expect(response.status).toBe(200);
      expect(confirmSessionDisconnectMock).toHaveBeenCalledTimes(1);
    });

    it("19: connecting and open do not trigger confirmSessionDisconnect", async () => {
      await callWebhook(
        webhookRequest({
          event: "connection.update",
          instance: INSTANCE_NAME,
          data: { state: "connecting" },
        }),
      );
      await callWebhook(
        webhookRequest({
          event: "connection.update",
          instance: INSTANCE_NAME,
          data: { state: "open" },
        }),
      );

      expect(confirmSessionDisconnectMock).not.toHaveBeenCalled();
    });

    it("20: confirmSessionDisconnect rejecting still returns 200 with no unhandled rejection", async () => {
      confirmSessionDisconnectMock.mockRejectedValueOnce(new Error("probe failed"));

      const response = await callWebhook(
        webhookRequest({
          event: "connection.update",
          instance: INSTANCE_NAME,
          data: { state: "close" },
        }),
      );
      await Promise.resolve();

      expect(response.status).toBe(200);
      expect(confirmSessionDisconnectMock).toHaveBeenCalledTimes(1);
    });
  });
});
