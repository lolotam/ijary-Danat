import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { WhatsappConnectionRow } from "@/integrations/supabase/database.types";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const EXPECTED_INSTANCE = "ijary-11111111111141118111111111111111";
const CONNECTION_ID = "22222222-2222-4222-8222-222222222222";
const TEST_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

interface StoredSecretRow {
  id: string;
  company_id: string;
  owner_kind: string;
  owner_id: string;
  name: string;
  ciphertext: string;
  iv: string;
  auth_tag: string;
  key_version: number;
  last4: string;
  version: number;
}

const dbBoundary = vi.hoisted(() => ({
  client: null as unknown,
}));

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => dbBoundary.client,
}));

import {
  deleteEvolutionInstance,
  ensureEvolutionInstance,
  evolutionInstanceName,
  fetchEvolutionQr,
  logoutEvolutionInstance,
} from "@/whatsapp/evolutionInstance";

/**
 * عميل قاعدة بيانات وهمي في الذاكرة لجدولي `whatsapp_connections` و `company_secrets`.
 */
function createFakeDb(options?: {
  connections?: WhatsappConnectionRow[];
  secrets?: StoredSecretRow[];
}) {
  const connections: WhatsappConnectionRow[] = [...(options?.connections ?? [])];
  const secrets: StoredSecretRow[] = [...(options?.secrets ?? [])];
  let secretSeq = 1;

  function makeQuery(table: "whatsapp_connections" | "company_secrets") {
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    let pendingInsert: Record<string, unknown> | Record<string, unknown>[] | null = null;
    let pendingUpdate: Record<string, unknown> | null = null;
    let orderBy: { col: string; ascending: boolean } | null = null;
    let limitCount: number | null = null;
    let wantSingle = false;
    let wantMaybeSingle = false;

    const execute = (): { data: unknown; error: { message: string } | null } => {
      if (table === "whatsapp_connections") {
        if (pendingInsert) {
          const item = Array.isArray(pendingInsert) ? pendingInsert[0] : pendingInsert;
          const now = "2026-11-27T12:00:00.000Z";
          const row: WhatsappConnectionRow = {
            id: (item.id as string) ?? CONNECTION_ID,
            company_id: item.company_id as string,
            method: item.method as WhatsappConnectionRow["method"],
            is_active: (item.is_active as boolean) ?? false,
            status: (item.status as WhatsappConnectionRow["status"]) ?? "disconnected",
            connected_number: (item.connected_number as string | null) ?? null,
            instance_name: (item.instance_name as string | null) ?? null,
            phone_number_id: (item.phone_number_id as string | null) ?? null,
            waba_id: (item.waba_id as string | null) ?? null,
            last_qr: (item.last_qr as string | null) ?? null,
            last_seen_at: (item.last_seen_at as string | null) ?? null,
            last_error: (item.last_error as string | null) ?? null,
            disconnect_alert_armed: (item.disconnect_alert_armed as boolean) ?? false,
            disconnected_at: (item.disconnected_at as string | null) ?? null,
            connected_at: (item.connected_at as string | null) ?? null,
            created_at: now,
            updated_at: now,
          };
          connections.push(row);
          return { data: wantSingle || wantMaybeSingle ? row : [row], error: null };
        }

        const matched = connections.filter((row) =>
          filters.every((fn) => fn(row as unknown as Record<string, unknown>)),
        );
        if (pendingUpdate) {
          for (const row of matched) Object.assign(row, pendingUpdate);
          return {
            data: wantSingle || wantMaybeSingle ? (matched[0] ?? null) : matched,
            error: null,
          };
        }
        return {
          data: wantSingle || wantMaybeSingle ? (matched[0] ?? null) : matched,
          error: null,
        };
      }

      if (pendingInsert) {
        const items = Array.isArray(pendingInsert) ? pendingInsert : [pendingInsert];
        for (const item of items) {
          secrets.push({
            id: `sec-${secretSeq++}`,
            company_id: item.company_id as string,
            owner_kind: item.owner_kind as string,
            owner_id: item.owner_id as string,
            name: item.name as string,
            ciphertext: item.ciphertext as string,
            iv: item.iv as string,
            auth_tag: item.auth_tag as string,
            key_version: item.key_version as number,
            last4: item.last4 as string,
            version: item.version as number,
          });
        }
        return { data: null, error: null };
      }

      let matched = secrets.filter((row) =>
        filters.every((fn) => fn(row as unknown as Record<string, unknown>)),
      );
      if (orderBy) {
        const { col, ascending } = orderBy;
        matched = [...matched].sort((a, b) => {
          const av = (a as unknown as Record<string, number>)[col] ?? 0;
          const bv = (b as unknown as Record<string, number>)[col] ?? 0;
          return ascending ? av - bv : bv - av;
        });
      }
      if (limitCount !== null) matched = matched.slice(0, limitCount);
      return {
        data: wantSingle || wantMaybeSingle ? (matched[0] ?? null) : matched,
        error: null,
      };
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      insert: (values: Record<string, unknown> | Record<string, unknown>[]) => {
        pendingInsert = values;
        return builder;
      },
      update: (values: Record<string, unknown>) => {
        pendingUpdate = values;
        return builder;
      },
      eq: (col: string, val: unknown) => {
        filters.push((row) => row[col] === val);
        return builder;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        orderBy = { col, ascending: opts?.ascending ?? true };
        return builder;
      },
      limit: (count: number) => {
        limitCount = count;
        return builder;
      },
      single: () => {
        wantSingle = true;
        return Promise.resolve(execute());
      },
      maybeSingle: () => {
        wantMaybeSingle = true;
        return Promise.resolve(execute());
      },
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(execute()).then(resolve, reject),
    };
    return builder;
  }

  return {
    connections,
    secrets,
    client: {
      from: (table: "whatsapp_connections" | "company_secrets") => makeQuery(table),
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("evolutionInstance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.EVOLUTION_API_URL = "https://evo.example.test";
    process.env.EVOLUTION_API_KEY = "evo-global-key";
    process.env.APP_BASE_URL = "https://ijary.app";
    process.env.INTEGRATIONS_MASTER_KEY = TEST_MASTER_KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("derives instance name without dashes from company id", () => {
    expect(evolutionInstanceName(COMPANY_ID)).toBe(EXPECTED_INSTANCE);
  });

  test("ensureEvolutionInstance creates row, registers webhook with per-connection secret, and encrypts secret", async () => {
    const db = createFakeDb();
    dbBoundary.client = db.client;

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ ok: true }, 201));
    vi.stubGlobal("fetch", fetchMock);

    const result = await ensureEvolutionInstance(COMPANY_ID);

    expect(result.instanceName).toBe(EXPECTED_INSTANCE);
    expect(result.connection.id).toBe(CONNECTION_ID);
    expect(db.connections).toHaveLength(1);
    expect(db.connections[0]).toMatchObject({
      company_id: COMPANY_ID,
      method: "evolution_qr",
      instance_name: EXPECTED_INSTANCE,
      status: "disconnected",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://evo.example.test/instance/create");
    const payload = JSON.parse(String(init?.body)) as {
      instanceName: string;
      webhook: { url: string; headers: Record<string, string>; events: string[] };
    };
    expect(payload.instanceName).toBe(EXPECTED_INSTANCE);
    expect(payload.webhook.url).toBe(
      `https://ijary.app/api/public/webhooks/evolution/${CONNECTION_ID}`,
    );
    const sentSecret = payload.webhook.headers["x-danat-webhook-secret"];
    expect(sentSecret).toBeTruthy();

    expect(db.secrets).toHaveLength(1);
    expect(db.secrets[0]).toMatchObject({
      company_id: COMPANY_ID,
      owner_kind: "whatsapp",
      owner_id: CONNECTION_ID,
      name: "webhook_secret",
      version: 1,
      last4: sentSecret.slice(-4),
    });
  });

  test("ensureEvolutionInstance falls back to setWebhook when instance already exists and bumps secret version", async () => {
    const existingRow: WhatsappConnectionRow = {
      id: CONNECTION_ID,
      company_id: COMPANY_ID,
      method: "evolution_qr",
      is_active: false,
      status: "disconnected",
      connected_number: null,
      instance_name: EXPECTED_INSTANCE,
      phone_number_id: null,
      waba_id: null,
      last_qr: null,
      last_seen_at: null,
      last_error: null,
      disconnect_alert_armed: false,
      disconnected_at: null,
      connected_at: null,
      created_at: "2026-11-27T10:00:00.000Z",
      updated_at: "2026-11-27T10:00:00.000Z",
    };
    const db = createFakeDb({
      connections: [existingRow],
      secrets: [
        {
          id: "sec-0",
          company_id: COMPANY_ID,
          owner_kind: "whatsapp",
          owner_id: CONNECTION_ID,
          name: "webhook_secret",
          ciphertext: "\\x00",
          iv: "\\x00",
          auth_tag: "\\x00",
          key_version: 1,
          last4: "abcd",
          version: 2,
        },
      ],
    });
    dbBoundary.client = db.client;

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ message: "Instance already exists" }, 403))
      .mockResolvedValueOnce(jsonResponse({ ok: true }, 200));
    vi.stubGlobal("fetch", fetchMock);

    await ensureEvolutionInstance(COMPANY_ID);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(
      `https://evo.example.test/webhook/set/${EXPECTED_INSTANCE}`,
    );
    expect(db.secrets).toHaveLength(2);
    expect(db.secrets[1].version).toBe(3);
  });

  test("fetchEvolutionQr stores last_qr and marks status pairing", async () => {
    const existingRow: WhatsappConnectionRow = {
      id: CONNECTION_ID,
      company_id: COMPANY_ID,
      method: "evolution_qr",
      is_active: true,
      status: "disconnected",
      connected_number: null,
      instance_name: EXPECTED_INSTANCE,
      phone_number_id: null,
      waba_id: null,
      last_qr: null,
      last_seen_at: null,
      last_error: null,
      disconnect_alert_armed: false,
      disconnected_at: null,
      connected_at: null,
      created_at: "2026-11-27T10:00:00.000Z",
      updated_at: "2026-11-27T10:00:00.000Z",
    };
    const db = createFakeDb({ connections: [existingRow] });
    dbBoundary.client = db.client;

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ base64: "data:image/png;base64,QR_DATA" }, 200));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchEvolutionQr(COMPANY_ID);

    expect(res.qr).toBe("data:image/png;base64,QR_DATA");
    expect(res.status).toBe("pairing");
    expect(db.connections[0].status).toBe("pairing");
    expect(db.connections[0].last_qr).toBe("data:image/png;base64,QR_DATA");
  });

  test("logoutEvolutionInstance sets status disconnected and clears last_qr", async () => {
    const existingRow: WhatsappConnectionRow = {
      id: CONNECTION_ID,
      company_id: COMPANY_ID,
      method: "evolution_qr",
      is_active: true,
      status: "connected",
      connected_number: "96550000000",
      instance_name: EXPECTED_INSTANCE,
      phone_number_id: null,
      waba_id: null,
      last_qr: "stale-qr",
      last_seen_at: "2026-11-27T10:00:00.000Z",
      last_error: null,
      disconnect_alert_armed: true,
      disconnected_at: null,
      connected_at: "2026-11-27T09:00:00.000Z",
      created_at: "2026-11-27T09:00:00.000Z",
      updated_at: "2026-11-27T10:00:00.000Z",
    };
    const db = createFakeDb({ connections: [existingRow] });
    dbBoundary.client = db.client;

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ ok: true }, 200));
    vi.stubGlobal("fetch", fetchMock);

    const res = await logoutEvolutionInstance(COMPANY_ID);

    expect(res).toEqual({ disconnected: true, status: "disconnected" });
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://evo.example.test/instance/logout/${EXPECTED_INSTANCE}`,
    );
    expect(db.connections[0]).toMatchObject({
      status: "disconnected",
      last_qr: null,
      connected_number: null,
      connected_at: null,
      disconnect_alert_armed: false,
    });
  });

  test("deleteEvolutionInstance deletes remote instance and resets local row", async () => {
    const existingRow: WhatsappConnectionRow = {
      id: CONNECTION_ID,
      company_id: COMPANY_ID,
      method: "evolution_qr",
      is_active: true,
      status: "disconnected",
      connected_number: null,
      instance_name: EXPECTED_INSTANCE,
      phone_number_id: null,
      waba_id: null,
      last_qr: "stale-qr",
      last_seen_at: null,
      last_error: null,
      disconnect_alert_armed: false,
      disconnected_at: null,
      connected_at: null,
      created_at: "2026-11-27T09:00:00.000Z",
      updated_at: "2026-11-27T10:00:00.000Z",
    };
    const db = createFakeDb({ connections: [existingRow] });
    dbBoundary.client = db.client;

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ ok: true }, 200));
    vi.stubGlobal("fetch", fetchMock);

    const res = await deleteEvolutionInstance(COMPANY_ID);

    expect(res).toEqual({ deleted: true });
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://evo.example.test/instance/delete/${EXPECTED_INSTANCE}`,
    );
    expect(db.connections[0]).toMatchObject({
      status: "disconnected",
      is_active: false,
      last_qr: null,
    });
  });
});
