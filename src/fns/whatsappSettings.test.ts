import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { WhatsappConnectionRow } from "@/integrations/supabase/database.types";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const EVO_ID = "22222222-2222-4222-8222-222222222222";
const CLOUD_ID = "33333333-3333-4333-8333-333333333333";
const TEST_MASTER_KEY = Buffer.alloc(32, 8).toString("base64");

const dbBoundary = vi.hoisted(() => ({
  client: null as unknown,
  permissionAllowed: true,
}));

vi.mock("@tanstack/react-start", () => {
  function makeFn() {
    const fn: any = (args?: { data?: unknown; context?: unknown }) =>
      fn._handler({
        data: fn._schema ? fn._schema.parse(args?.data) : args?.data,
        context: args?.context ?? fn._context ?? {},
      });
    fn.middleware = vi.fn().mockReturnValue(fn);
    fn.validator = vi.fn().mockImplementation((schema: any) => {
      fn._schema = schema;
      return fn;
    });
    fn.inputValidator = vi.fn().mockReturnValue(fn);
    fn.handler = vi.fn().mockImplementation((handler: any) => {
      fn._handler = handler;
      return fn;
    });
    return fn;
  }
  return {
    createServerFn: vi.fn().mockImplementation(() => makeFn()),
  };
});

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => {
    throw new Error("No active HTTP request in unit test");
  },
}));

vi.mock("@/integrations/supabase/auth-middleware", () => ({
  requireSupabaseAuth: vi.fn(),
}));

vi.mock("@/fns/requirePermission", () => ({
  requirePermission: vi.fn(async () => {
    if (!dbBoundary.permissionAllowed) {
      throw new Error("You do not have permission to manage the WhatsApp connection.");
    }
  }),
}));

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => dbBoundary.client,
}));

vi.mock("@/company/requestCompany.server", () => ({
  requireRequestCompany: () => ({
    id: COMPANY_ID,
    slug: "acme",
    status: "active",
    host: "acme.ijary.app",
  }),
}));

import {
  whatsappActivate,
  whatsappDisconnect,
  whatsappStartQr,
  whatsappStatus,
} from "@/fns/whatsappSettings";

/**
 * عميل قاعدة بيانات وهمي في الذاكرة يتحقق من قيد الاتصال النشط الواحد لكل شركة.
 */
function createFakeWhatsappDb(initialRows: WhatsappConnectionRow[] = []) {
  const rows: WhatsappConnectionRow[] = initialRows.map((r) => ({ ...r }));
  const secrets: Array<Record<string, unknown>> = [];

  function makeQuery(table: "whatsapp_connections" | "company_secrets") {
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    let pendingInsert: Record<string, unknown> | null = null;
    let pendingUpdate: Record<string, unknown> | null = null;
    let wantSingle = false;
    let wantMaybeSingle = false;

    const execute = (): { data: unknown; error: { message: string } | null } => {
      if (table === "company_secrets") {
        if (pendingInsert) {
          secrets.push(pendingInsert);
          return { data: null, error: null };
        }
        return { data: wantMaybeSingle || wantSingle ? null : [], error: null };
      }

      if (pendingInsert) {
        const now = "2026-11-27T12:00:00.000Z";
        const row: WhatsappConnectionRow = {
          id: EVO_ID,
          company_id: pendingInsert.company_id as string,
          method: pendingInsert.method as WhatsappConnectionRow["method"],
          is_active: (pendingInsert.is_active as boolean) ?? false,
          status: (pendingInsert.status as WhatsappConnectionRow["status"]) ?? "disconnected",
          connected_number: null,
          instance_name: (pendingInsert.instance_name as string | null) ?? null,
          phone_number_id: null,
          waba_id: null,
          last_qr: null,
          last_seen_at: null,
          last_error: null,
          disconnect_alert_armed: false,
          disconnected_at: null,
          connected_at: null,
          created_at: now,
          updated_at: now,
        };
        rows.push(row);
        return { data: wantSingle || wantMaybeSingle ? row : [row], error: null };
      }

      const matched = rows.filter((row) =>
        filters.every((fn) => fn(row as unknown as Record<string, unknown>)),
      );

      if (pendingUpdate) {
        if (pendingUpdate.is_active === true) {
          const otherActive = rows.some(
            (r) => r.company_id === COMPANY_ID && r.is_active && !matched.includes(r),
          );
          if (otherActive) {
            return {
              data: null,
              error: {
                message:
                  'duplicate key value violates unique constraint "whatsapp_connections_one_active_per_company"',
              },
            };
          }
        }
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
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      insert: (values: Record<string, unknown>) => {
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
      neq: (col: string, val: unknown) => {
        filters.push((row) => row[col] !== val);
        return builder;
      },
      order: () => builder,
      limit: () => builder,
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
    rows,
    secrets,
    client: {
      from: (table: "whatsapp_connections" | "company_secrets") => makeQuery(table),
    },
  };
}

function makeConnection(overrides: Partial<WhatsappConnectionRow> = {}): WhatsappConnectionRow {
  return {
    id: EVO_ID,
    company_id: COMPANY_ID,
    method: "evolution_qr",
    is_active: true,
    status: "disconnected",
    connected_number: null,
    instance_name: `ijary-${COMPANY_ID.replace(/-/g, "")}`,
    phone_number_id: null,
    waba_id: null,
    last_qr: "secret-qr-payload",
    last_seen_at: "2026-11-27T11:30:00.000Z",
    last_error: null,
    disconnect_alert_armed: false,
    disconnected_at: null,
    connected_at: null,
    created_at: "2026-11-27T10:00:00.000Z",
    updated_at: "2026-11-27T11:30:00.000Z",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("whatsappSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbBoundary.permissionAllowed = true;
    process.env.EVOLUTION_API_URL = "https://evo.example.test";
    process.env.EVOLUTION_API_KEY = "evo-global-key";
    process.env.APP_BASE_URL = "https://ijary.app";
    process.env.INTEGRATIONS_MASTER_KEY = TEST_MASTER_KEY;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test.each([
    { status: "pairing" as const, expectedQr: "secret-qr-payload" },
    { status: "connected" as const, expectedQr: null },
    { status: "disconnected" as const, expectedQr: null },
    { status: "error" as const, expectedQr: null },
  ])(
    "whatsappStatus exposes lastQr only when status is pairing ($status)",
    async ({ status, expectedQr }) => {
      const db = createFakeWhatsappDb([
        makeConnection({ status, connected_number: "96550001111" }),
      ]);
      dbBoundary.client = db.client;

      const result = await whatsappStatus();

      expect(result.active).toMatchObject({
        method: "evolution_qr",
        status,
        connectedNumber: "96550001111",
        lastSeenAt: "2026-11-27T11:30:00.000Z",
        lastQr: expectedQr,
      });
    },
  );

  test.each([
    {
      name: "whatsappStartQr",
      call: (ctx: unknown) =>
        (whatsappStartQr as unknown as (args: unknown) => Promise<unknown>)({ context: ctx }),
    },
    {
      name: "whatsappDisconnect",
      call: (ctx: unknown) =>
        (whatsappDisconnect as unknown as (args: unknown) => Promise<unknown>)({
          data: {},
          context: ctx,
        }),
    },
    {
      name: "whatsappActivate",
      call: (ctx: unknown) =>
        (whatsappActivate as unknown as (args: unknown) => Promise<unknown>)({
          data: { method: "cloud_api" },
          context: ctx,
        }),
    },
  ])(
    "$name rejects support impersonation sessions with SUPPORT_SESSION_FORBIDDEN",
    async ({ call }) => {
      dbBoundary.client = createFakeWhatsappDb().client;

      await expect(call({ claims: { impersonator: "admin-1" } })).rejects.toThrow(
        "SUPPORT_SESSION_FORBIDDEN",
      );
    },
  );

  test("whatsappStartQr ensures Evolution instance, fetches QR, and activates evolution_qr", async () => {
    const cloudRow = makeConnection({
      id: CLOUD_ID,
      method: "cloud_api",
      is_active: true,
      status: "connected",
      instance_name: null,
      last_qr: null,
    });
    const db = createFakeWhatsappDb([cloudRow]);
    dbBoundary.client = db.client;

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ok: true }, 201))
      .mockResolvedValueOnce(jsonResponse({ base64: "qr-code-123" }, 200));
    vi.stubGlobal("fetch", fetchMock);

    const res = await whatsappStartQr();

    expect(res).toEqual({
      connectionId: EVO_ID,
      qr: "qr-code-123",
      status: "pairing",
    });
    expect(db.rows.find((r) => r.method === "cloud_api")?.is_active).toBe(false);
    const evoRow = db.rows.find((r) => r.method === "evolution_qr");
    expect(evoRow?.is_active).toBe(true);
    expect(evoRow?.status).toBe("pairing");
  });

  test("whatsappActivate deactivates the previous method before activating the target method", async () => {
    const evoRow = makeConnection({ id: EVO_ID, method: "evolution_qr", is_active: true });
    const cloudRow = makeConnection({
      id: CLOUD_ID,
      method: "cloud_api",
      is_active: false,
      status: "connected",
      last_qr: null,
    });
    const db = createFakeWhatsappDb([evoRow, cloudRow]);
    dbBoundary.client = db.client;

    const activated = await whatsappActivate({ data: { method: "cloud_api" } });

    expect(activated.method).toBe("cloud_api");
    expect(activated.isActive).toBe(true);
    expect(db.rows.find((r) => r.method === "evolution_qr")?.is_active).toBe(false);
    expect(db.rows.find((r) => r.method === "cloud_api")?.is_active).toBe(true);
  });

  test("whatsappDisconnect logs out Evolution instance and clears last_qr", async () => {
    const evoRow = makeConnection({
      id: EVO_ID,
      method: "evolution_qr",
      is_active: true,
      status: "connected",
    });
    const db = createFakeWhatsappDb([evoRow]);
    dbBoundary.client = db.client;

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ ok: true }, 200));
    vi.stubGlobal("fetch", fetchMock);

    const res = await whatsappDisconnect({ data: {} });

    expect(res).toEqual({ disconnected: true, status: "disconnected" });
    const updatedEvo = db.rows.find((r) => r.method === "evolution_qr");
    expect(updatedEvo?.status).toBe("disconnected");
    expect(updatedEvo?.last_qr).toBeNull();
  });
});
