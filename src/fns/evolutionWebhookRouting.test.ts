import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * توجيه ويبهوك Evolution حسب معرّف الاتصال: كل شركة تستقبل أحداثها وحدها.
 *
 * The webhook arrives with no session and no company host, so the connection
 * id in the URL is the only thing that says which company the event belongs
 * to. These cases pin that routing down: the secret decides which connection
 * may write, and one company's event never reaches another company's rows.
 */

vi.mock("@tanstack/react-start", () => ({
  createServerFn: vi.fn().mockReturnValue({
    middleware: vi.fn().mockReturnThis(),
    validator: vi.fn().mockReturnThis(),
    handler: vi.fn().mockReturnThis(),
  }),
  createMiddleware: vi.fn().mockReturnValue({ server: vi.fn() }),
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: vi.fn() }));

// The webhook secret is decrypted for real, so the test needs a master key and
// the same encrypt/bytea helpers the pairing path uses.
process.env.INTEGRATIONS_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");

import { encodeByteaHex } from "@/gateways/connectionStore.server";
import { encryptSecret } from "@/lib/secrets.server";

const COMPANY_A = "00000000-0000-4000-8000-00000000000a";
const COMPANY_B = "00000000-0000-4000-8000-00000000000b";
const CONNECTION_A = "11111111-1111-4111-8111-111111111111";
const CONNECTION_B = "22222222-2222-4222-8222-222222222222";
const INACTIVE_CONNECTION = "33333333-3333-4333-8333-333333333333";
const UNKNOWN_CONNECTION = "44444444-4444-4444-8444-444444444444";
const SECRET_A = "secret-a";
const SECRET_B = "secret-b";
const INSTANCE_A = "ijary-company-a";
const INSTANCE_B = "ijary-company-b";

/** صفّ اتصال كما تجيب عنه دالة قاعدة البيانات. */
interface ConnectionRow {
  id: string;
  company_id: string;
  method: string;
  is_active: boolean;
  status: string;
  instance_name: string | null;
}

/** بديل مبسّط لعميل Supabase: يقرأ من صفوف ثابتة ويسجّل ما طُلب منه. */
interface ClientStub {
  companyId: string;
  updates: Array<{ table: string; values: Record<string, unknown> }>;
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }>;
  from: (table: string) => unknown;
  rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: null }>;
}

const connections: Record<string, ConnectionRow> = {
  [CONNECTION_A]: {
    id: CONNECTION_A,
    company_id: COMPANY_A,
    method: "evolution_qr",
    is_active: true,
    status: "connected",
    instance_name: INSTANCE_A,
  },
  [CONNECTION_B]: {
    id: CONNECTION_B,
    company_id: COMPANY_B,
    method: "evolution_qr",
    is_active: true,
    status: "connected",
    instance_name: INSTANCE_B,
  },
  [INACTIVE_CONNECTION]: {
    id: INACTIVE_CONNECTION,
    company_id: COMPANY_A,
    method: "evolution_qr",
    is_active: false,
    status: "disconnected",
    instance_name: "ijary-inactive",
  },
};

/** يبني صفّ سرّ مشفّر كما تكتبه دالة الاقتران. */
function secretRow(plain: string, connectionId: string, version: number): Record<string, unknown> {
  const encrypted = encryptSecret(plain);
  return {
    owner_kind: "whatsapp",
    owner_id: connectionId,
    name: "webhook_secret",
    ciphertext: encodeByteaHex(encrypted.ciphertext),
    iv: encodeByteaHex(encrypted.iv),
    auth_tag: encodeByteaHex(encrypted.authTag),
    key_version: encrypted.keyVersion,
    version,
  };
}

/**
 * يبني عميلاً يقرأ من جداول ثابتة ويسجّل التحديثات واستدعاءات الدوال.
 *
 * The queries the webhook really makes are answered for real: the
 * encrypted secrets of one connection, and the ingestion.
 */
function createClientStub(
  companyId: string,
  tables: Record<string, Array<Record<string, unknown>>>,
): ClientStub {
  const updates: ClientStub["updates"] = [];
  const rpcCalls: ClientStub["rpcCalls"] = [];

  function builder(table: string) {
    const filters: Array<[string, unknown]> = [];
    let values: Record<string, unknown> | null = null;
    let limit = 0;
    const chain: any = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        return chain;
      },
      order: () => chain,
      limit: (count: number) => {
        limit = count;
        return chain;
      },
      maybeSingle: async () => ({ data: matchingRows()[0] ?? null, error: null }),
      update: (next: Record<string, unknown>) => {
        values = next;
        return chain;
      },
      then: (onFulfilled: (value: unknown) => unknown) => {
        if (values) updates.push({ table, values });
        const rows = matchingRows();
        return Promise.resolve({ data: limit ? rows.slice(0, limit) : rows, error: null }).then(
          onFulfilled,
        );
      },
    };

    /** الصفوف المطابقة للفلاتر، الأحدث إصداراً أولاً. */
    function matchingRows(): Array<Record<string, unknown>> {
      const rows = tables[table] ?? [];
      const filtered = rows.filter((row) =>
        filters.every(([column, value]) => row[column] === value),
      );
      return [...filtered].sort((left, right) => Number(right.version) - Number(left.version));
    }

    return chain;
  }

  return {
    companyId,
    updates,
    rpcCalls,
    from: (table: string) => builder(table),
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      return Promise.resolve({ data: 1, error: null });
    },
  };
}

const clients = new Map<string, ClientStub>();

vi.mock("@/company/companyClient.server", () => ({
  companyClient: (companyId: string) => {
    const existing = clients.get(companyId);
    if (!existing) throw new Error(`Unexpected company client: ${companyId}`);
    return existing;
  },
}));

// The owner lookup is the platform's read across companies (a database
// boundary); the stub answers it from the fixed connection rows.
vi.mock("@/platform/whatsappConnectionLookup.server", () => ({
  lookupWhatsappConnectionById: async (connectionId: string) => connections[connectionId] ?? null,
}));

import { respondToEvolutionWebhook } from "./evolutionWebhook";

/** يبني طلب ويبهوك كما يرسله Evolution. */
function webhookRequest(
  connectionId: string,
  secret: string,
  body: Record<string, unknown> = {},
): Request {
  return new Request(`https://ijary.app/api/public/webhooks/evolution/${connectionId}`, {
    method: "POST",
    headers: { "x-danat-webhook-secret": secret, "Content-Type": "application/json" },
    body: JSON.stringify({
      event: "messages.upsert",
      instance: INSTANCE_A,
      data: [
        {
          key: { id: "wamid-1", remoteJid: "96550123456@s.whatsapp.net", fromMe: false },
          message: { conversation: "السلام عليكم" },
        },
      ],
      ...body,
    }),
  });
}

beforeEach(() => {
  clients.clear();
  clients.set(
    COMPANY_A,
    createClientStub(COMPANY_A, { company_secrets: [secretRow(SECRET_A, CONNECTION_A, 1)] }),
  );
  clients.set(
    COMPANY_B,
    createClientStub(COMPANY_B, { company_secrets: [secretRow(SECRET_B, CONNECTION_B, 1)] }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("evolution webhook routing by connection", () => {
  it("delivers the event to the company that owns the connection", async () => {
    const response = await respondToEvolutionWebhook(
      webhookRequest(CONNECTION_A, SECRET_A),
      CONNECTION_A,
    );

    expect(response.status).toBe(200);
    expect(clients.get(COMPANY_A)!.rpcCalls.map((call) => call.name)).toContain(
      "ingest_whatsapp_messages",
    );
    expect(clients.get(COMPANY_B)!.rpcCalls).toEqual([]);
    expect(clients.get(COMPANY_B)!.updates).toEqual([]);
  });

  it("refuses a delivery signed with another connection's secret", async () => {
    const response = await respondToEvolutionWebhook(
      webhookRequest(CONNECTION_A, SECRET_B),
      CONNECTION_A,
    );

    expect(response.status).toBe(401);
    expect(clients.get(COMPANY_A)!.rpcCalls).toEqual([]);
    expect(clients.get(COMPANY_B)!.rpcCalls).toEqual([]);
  });

  it("refuses an unknown connection without revealing anything", async () => {
    const response = await respondToEvolutionWebhook(
      webhookRequest(UNKNOWN_CONNECTION, SECRET_A),
      UNKNOWN_CONNECTION,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found." });
    expect(clients.get(COMPANY_A)!.rpcCalls).toEqual([]);
    expect(clients.get(COMPANY_B)!.rpcCalls).toEqual([]);
  });

  it("refuses a connection that is not the company's active method", async () => {
    const response = await respondToEvolutionWebhook(
      webhookRequest(INACTIVE_CONNECTION, SECRET_A),
      INACTIVE_CONNECTION,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found." });
    expect(clients.get(COMPANY_A)!.rpcCalls).toEqual([]);
  });

  it("refuses a connection id that is not a uuid", async () => {
    const response = await respondToEvolutionWebhook(
      webhookRequest("not-a-uuid", SECRET_A),
      "not-a-uuid",
    );

    expect(response.status).toBe(404);
    expect(clients.get(COMPANY_A)!.rpcCalls).toEqual([]);
  });

  it("refuses an event whose payload names another instance", async () => {
    const response = await respondToEvolutionWebhook(
      webhookRequest(CONNECTION_A, SECRET_A, { instance: INSTANCE_B }),
      CONNECTION_A,
    );

    expect(response.status).toBe(401);
    expect(clients.get(COMPANY_A)!.rpcCalls).toEqual([]);
  });

  it("reports a missing secret as a server fault instead of accepting the delivery", async () => {
    clients.set(COMPANY_A, createClientStub(COMPANY_A, {}));

    const response = await respondToEvolutionWebhook(
      webhookRequest(CONNECTION_A, SECRET_A),
      CONNECTION_A,
    );

    expect(response.status).toBe(503);
    expect(clients.get(COMPANY_A)!.rpcCalls).toEqual([]);
  });
});
