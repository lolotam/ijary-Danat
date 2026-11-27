import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const constants = vi.hoisted(() => ({
  COMPANY_ID: "11111111-1111-4111-8111-111111111111",
  MF_CONNECTION_ID: "22222222-2222-4222-8222-222222222222",
  TAP_CONNECTION_ID: "33333333-3333-4333-8333-333333333333",
}));

const dbBoundary = vi.hoisted(() => ({
  client: null as unknown,
}));

vi.mock("@tanstack/react-start", () => {
  function makeFn() {
    const fn: any = (data: any) => fn._handler({ data, context: fn._context });
    fn.middleware = vi.fn().mockReturnValue(fn);
    fn.validator = vi.fn().mockImplementation((schema: any) => {
      fn._schema = schema;
      return fn;
    });
    fn.inputValidator = vi.fn().mockReturnValue(fn);
    fn.handler = vi.fn().mockImplementation((handler: any) => {
      fn._handler = async (args: any) =>
        handler({ ...args, data: fn._schema ? fn._schema.parse(args.data) : args.data });
      return fn;
    });
    return fn;
  }
  return {
    createServerFn: vi.fn().mockImplementation(() => makeFn()),
    createMiddleware: vi.fn().mockReturnValue({
      server: vi.fn().mockImplementation((middlewareFn: any) => middlewareFn),
    }),
  };
});

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => dbBoundary.client,
}));

vi.mock("@/company/requestCompany.server", () => ({
  requireRequestCompany: () => ({
    id: constants.COMPANY_ID,
    slug: "acme",
    status: "active",
    host: "acme.localhost",
  }),
}));

import {
  gatewayActivate,
  gatewayDeactivate,
  gatewayList,
  gatewaySaveCredentials,
  GatewaySettingsError,
  gatewayTestConnection,
} from "@/fns/gatewaySettings";
import type { GatewayConnectionRow } from "@/integrations/supabase/database.types";

const TEST_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");

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
  updated_at: string;
}

interface AuditCall {
  p_action: string;
  p_entity_type: string | null;
  p_entity_id: string | null;
  p_before: unknown;
  p_after: unknown;
  p_result: string;
  p_error_code: string | null;
}

/**
 * عميل قاعدة بيانات وهمي في الذاكرة لاختبارات إعدادات بوابات الدفع.
 */
function createFakeGatewayDb(options?: {
  connections?: GatewayConnectionRow[];
  secrets?: StoredSecretRow[];
  moduleEnabled?: boolean;
  updateErrorOnActivate?: string;
}) {
  const connections: GatewayConnectionRow[] = [...(options?.connections ?? [])];
  const secrets: StoredSecretRow[] = [...(options?.secrets ?? [])];
  const audits: AuditCall[] = [];
  let seq = 1;

  function makeQuery(table: "gateway_connections" | "company_secrets" | "company_secret_previews") {
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    let pendingInsert: Record<string, unknown> | Record<string, unknown>[] | null = null;
    let pendingUpdate: Record<string, unknown> | null = null;
    let wantSingle = false;
    let wantMaybeSingle = false;

    const execute = (): { data: unknown; error: { message: string } | null } => {
      if (table === "gateway_connections") {
        if (pendingInsert) {
          const item = Array.isArray(pendingInsert) ? pendingInsert[0] : pendingInsert;
          const now = "2026-11-27T11:00:00.000Z";
          const id =
            item.provider === "myfatoorah"
              ? constants.MF_CONNECTION_ID
              : constants.TAP_CONNECTION_ID;
          const row: GatewayConnectionRow = {
            id,
            company_id: item.company_id as string,
            provider: item.provider as GatewayConnectionRow["provider"],
            mode: (item.mode as GatewayConnectionRow["mode"]) ?? "test",
            public_config: (item.public_config as GatewayConnectionRow["public_config"]) ?? {},
            is_active: false,
            last_test_at: null,
            last_test_ok: false,
            last_test_message: null,
            credentials_version: (item.credentials_version as number) ?? 1,
            created_at: now,
            updated_at: now,
          };
          connections.push(row);
          return { data: wantSingle || wantMaybeSingle ? row : [row], error: null };
        }

        if (pendingUpdate) {
          if (pendingUpdate.is_active === true && options?.updateErrorOnActivate) {
            return { data: null, error: { message: options.updateErrorOnActivate } };
          }
          const matched = connections.filter((row) =>
            filters.every((fn) => fn(row as unknown as Record<string, unknown>)),
          );
          for (const row of matched) {
            const versionChanged =
              pendingUpdate.credentials_version !== undefined &&
              pendingUpdate.credentials_version !== row.credentials_version;
            Object.assign(row, pendingUpdate);
            if (versionChanged && pendingUpdate.last_test_at === undefined) {
              row.last_test_ok = false;
              row.last_test_at = null;
              row.last_test_message = null;
              row.is_active = false;
            }
          }
          return {
            data: wantSingle || wantMaybeSingle ? (matched[0] ?? null) : matched,
            error: null,
          };
        }

        const matched = connections.filter((row) =>
          filters.every((fn) => fn(row as unknown as Record<string, unknown>)),
        );
        if (wantMaybeSingle) return { data: matched[0] ?? null, error: null };
        if (wantSingle) {
          return matched[0]
            ? { data: matched[0], error: null }
            : { data: null, error: { message: "Row not found" } };
        }
        return { data: matched, error: null };
      }

      if (table === "company_secrets") {
        if (pendingInsert) {
          const items = Array.isArray(pendingInsert) ? pendingInsert : [pendingInsert];
          const inserted: StoredSecretRow[] = items.map((item) => {
            const row: StoredSecretRow = {
              id: `sec-${seq++}`,
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
              updated_at: "2026-11-27T11:00:00.000Z",
            };
            secrets.push(row);
            return row;
          });
          return { data: inserted, error: null };
        }

        const matched = secrets.filter((row) =>
          filters.every((fn) => fn(row as unknown as Record<string, unknown>)),
        );
        return { data: matched, error: null };
      }

      // company_secret_previews — projects only preview columns, never encrypted columns.
      const matched = secrets
        .filter((row) => filters.every((fn) => fn(row as unknown as Record<string, unknown>)))
        .map(({ id, company_id, owner_kind, owner_id, name, last4, version, updated_at }) => ({
          id,
          company_id,
          owner_kind,
          owner_id,
          name,
          last4,
          version,
          updated_at,
        }));
      return { data: matched, error: null };
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (col: string, val: unknown) => {
        filters.push((row) => row[col] === val);
        return builder;
      },
      neq: (col: string, val: unknown) => {
        filters.push((row) => row[col] !== val);
        return builder;
      },
      insert: (payload: Record<string, unknown> | Record<string, unknown>[]) => {
        pendingInsert = payload;
        return builder;
      },
      update: (payload: Record<string, unknown>) => {
        pendingUpdate = payload;
        return builder;
      },
      maybeSingle: () => {
        wantMaybeSingle = true;
        return builder;
      },
      single: () => {
        wantSingle = true;
        return builder;
      },
      then: (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
        Promise.resolve(execute()).then(resolve, reject),
    };
    return builder;
  }

  const client = {
    from: (table: "gateway_connections" | "company_secrets" | "company_secret_previews") =>
      makeQuery(table),
    rpc: vi.fn().mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      if (name === "current_company_id") return { data: constants.COMPANY_ID, error: null };
      if (name === "module_enabled") {
        return { data: options?.moduleEnabled ?? true, error: null };
      }
      if (name === "write_audit") {
        audits.push(args as unknown as AuditCall);
        return { data: `audit-${audits.length}`, error: null };
      }
      return { data: null, error: null };
    }),
  };

  dbBoundary.client = client;
  return { client, connections, secrets, audits };
}

/** سياق مستخدم موقّع الدخول يحمل أو لا يحمل صلاحية `settings.integrations`. */
function authContext(allowed: boolean) {
  return {
    userId: "user-1",
    supabase: {
      rpc: vi.fn().mockImplementation(async (name: string) => {
        if (name === "has_permission") return { data: allowed, error: null };
        if (name === "write_audit") return { data: "audit-denied", error: null };
        return { data: null, error: null };
      }),
    },
  };
}

/** يستدعي دالة خادم وهميةً في سياق مستخدم محدّد. */
function callServerFn<T>(fn: unknown, context: unknown, input?: unknown): Promise<T> {
  const serverFn = fn as { _context: unknown; (data?: unknown): Promise<T> };
  serverFn._context = context;
  return serverFn(input);
}

const originalMasterKey = process.env.INTEGRATIONS_MASTER_KEY;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.INTEGRATIONS_MASTER_KEY = TEST_MASTER_KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalMasterKey === undefined) {
    delete process.env.INTEGRATIONS_MASTER_KEY;
  } else {
    process.env.INTEGRATIONS_MASTER_KEY = originalMasterKey;
  }
});

describe("gatewaySettings permissions", () => {
  test.each([
    ["gatewayList", gatewayList, undefined],
    [
      "gatewaySaveCredentials",
      gatewaySaveCredentials,
      {
        provider: "myfatoorah",
        mode: "test",
        publicConfig: {},
        credentials: { apiKey: "secret-1234" },
      },
    ],
    ["gatewayTestConnection", gatewayTestConnection, { provider: "myfatoorah" }],
    ["gatewayActivate", gatewayActivate, { provider: "myfatoorah" }],
    ["gatewayDeactivate", gatewayDeactivate, { provider: "myfatoorah" }],
  ])("refuses %s when caller lacks settings.integrations permission", async (_name, fn, input) => {
    const { connections } = createFakeGatewayDb();
    await expect(callServerFn(fn, authContext(false), input)).rejects.toThrow(/permission/i);
    expect(connections).toHaveLength(0);
  });
});

describe("gatewaySaveCredentials and gatewayList", () => {
  test("saves encrypted credentials, writes secret-free audit, and lists only last4 previews", async () => {
    const { audits } = createFakeGatewayDb();
    const secretValue = "mf_live_super_secret_token_7890";

    const saved = await callServerFn<Record<string, unknown>>(
      gatewaySaveCredentials,
      authContext(true),
      {
        provider: "myfatoorah",
        mode: "test",
        publicConfig: { enabledMethods: ["knet"] },
        credentials: { apiKey: secretValue },
      },
    );

    expect(saved).toMatchObject({
      provider: "myfatoorah",
      mode: "test",
      isActive: false,
      credentialsVersion: 1,
    });
    expect(JSON.stringify(saved)).not.toContain(secretValue);
    expect(audits).toHaveLength(1);
    expect(audits[0].p_action).toBe("gateway.save_credentials");
    expect(JSON.stringify(audits[0])).not.toContain(secretValue);

    const list = await callServerFn<Array<Record<string, unknown>>>(gatewayList, authContext(true));
    const mf = list.find((item) => item.provider === "myfatoorah");
    expect(mf).toMatchObject({
      provider: "myfatoorah",
      configured: true,
      mode: "test",
      isActive: false,
      secretPreviews: [{ name: "apiKey", last4: "7890" }],
    });
    expect(JSON.stringify(list)).not.toContain(secretValue);
    expect(JSON.stringify(list)).not.toContain("ciphertext");
  });
});

describe("gatewayTestConnection", () => {
  test("runs adapter testConnection via gatewayRegistry and persists result", async () => {
    const { connections, audits } = createFakeGatewayDb();
    await callServerFn(gatewaySaveCredentials, authContext(true), {
      provider: "myfatoorah",
      mode: "test",
      publicConfig: {},
      credentials: { apiKey: "mf_test_key_5555" },
    });

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          IsSuccess: true,
          Data: { PaymentMethods: [{ ApiName: "KNET" }, { ApiName: "VISA/MASTER" }] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    const result = await callServerFn<{ ok: boolean; message: string; testedAt: string }>(
      gatewayTestConnection,
      authContext(true),
      { provider: "myfatoorah" },
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain("KNET");
    expect(connections[0].last_test_ok).toBe(true);
    expect(connections[0].last_test_at).toBe(result.testedAt);
    expect(connections[0].last_test_message).toBe(result.message);
    expect(audits.map((a) => a.p_action)).toContain("gateway.test");
  });

  test("deactivates an active connection when a re-test fails", async () => {
    const { connections } = createFakeGatewayDb({
      connections: [
        {
          id: constants.MF_CONNECTION_ID,
          company_id: constants.COMPANY_ID,
          provider: "myfatoorah",
          mode: "test",
          public_config: {},
          is_active: true,
          last_test_at: "2026-11-27T09:00:00.000Z",
          last_test_ok: true,
          last_test_message: "ok",
          credentials_version: 1,
          created_at: "2026-11-27T09:00:00.000Z",
          updated_at: "2026-11-27T09:00:00.000Z",
        },
      ],
    });
    // Save credentials on v1? Update directly or seed via save first.
    await callServerFn(gatewaySaveCredentials, authContext(true), {
      provider: "myfatoorah",
      mode: "test",
      publicConfig: {},
      credentials: { apiKey: "mf_bad_key_0000" },
    });
    connections[0].last_test_ok = true;
    connections[0].last_test_at = "2026-11-27T09:00:00.000Z";
    connections[0].is_active = true;

    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }),
      ) as unknown as typeof fetch;

    const result = await callServerFn<{ ok: boolean; message: string }>(
      gatewayTestConnection,
      authContext(true),
      { provider: "myfatoorah" },
    );

    expect(result.ok).toBe(false);
    expect(connections[0].last_test_ok).toBe(false);
    expect(connections[0].is_active).toBe(false);
  });
});

describe("gatewayActivate and gatewayDeactivate", () => {
  test("refuses activation with TEST_REQUIRED when connection has not passed a test", async () => {
    createFakeGatewayDb();
    await callServerFn(gatewaySaveCredentials, authContext(true), {
      provider: "myfatoorah",
      mode: "test",
      publicConfig: {},
      credentials: { apiKey: "mf_test_1234" },
    });

    await expect(
      callServerFn(gatewayActivate, authContext(true), { provider: "myfatoorah" }),
    ).rejects.toMatchObject({
      name: "GatewaySettingsError",
      code: "TEST_REQUIRED",
    });
  });

  test.each([
    [
      'new row for gateway_connections violates check constraint "gateway_connections_active_requires_passing_test"',
      "TEST_REQUIRED",
    ],
    [
      'duplicate key value violates unique constraint "gateway_connections_one_active_per_company"',
      "ONE_ACTIVE_GATEWAY",
    ],
  ])("maps database constraint error %s to %s", async (dbMessage, expectedCode) => {
    createFakeGatewayDb({
      connections: [
        {
          id: constants.MF_CONNECTION_ID,
          company_id: constants.COMPANY_ID,
          provider: "myfatoorah",
          mode: "test",
          public_config: {},
          is_active: false,
          last_test_at: "2026-11-27T09:00:00.000Z",
          last_test_ok: true,
          last_test_message: "ok",
          credentials_version: 1,
          created_at: "2026-11-27T09:00:00.000Z",
          updated_at: "2026-11-27T09:00:00.000Z",
        },
      ],
      updateErrorOnActivate: dbMessage,
    });

    await expect(
      callServerFn(gatewayActivate, authContext(true), { provider: "myfatoorah" }),
    ).rejects.toBeInstanceOf(GatewaySettingsError);

    await expect(
      callServerFn(gatewayActivate, authContext(true), { provider: "myfatoorah" }),
    ).rejects.toMatchObject({ code: expectedCode });
  });

  test("activates tested gateway, deactivates previous active gateway, and supports deactivation", async () => {
    const { connections, audits } = createFakeGatewayDb({
      connections: [
        {
          id: constants.TAP_CONNECTION_ID,
          company_id: constants.COMPANY_ID,
          provider: "tap",
          mode: "test",
          public_config: {},
          is_active: true,
          last_test_at: "2026-11-27T09:00:00.000Z",
          last_test_ok: true,
          last_test_message: "ok",
          credentials_version: 1,
          created_at: "2026-11-27T09:00:00.000Z",
          updated_at: "2026-11-27T09:00:00.000Z",
        },
        {
          id: constants.MF_CONNECTION_ID,
          company_id: constants.COMPANY_ID,
          provider: "myfatoorah",
          mode: "test",
          public_config: {},
          is_active: false,
          last_test_at: "2026-11-27T09:05:00.000Z",
          last_test_ok: true,
          last_test_message: "ok",
          credentials_version: 1,
          created_at: "2026-11-27T09:05:00.000Z",
          updated_at: "2026-11-27T09:05:00.000Z",
        },
      ],
    });

    const activated = await callServerFn<{ provider: string; isActive: boolean }>(
      gatewayActivate,
      authContext(true),
      { provider: "myfatoorah" },
    );
    expect(activated).toMatchObject({ provider: "myfatoorah", isActive: true });
    expect(connections.find((c) => c.provider === "tap")?.is_active).toBe(false);
    expect(connections.find((c) => c.provider === "myfatoorah")?.is_active).toBe(true);

    const deactivated = await callServerFn<{ provider: string; isActive: boolean }>(
      gatewayDeactivate,
      authContext(true),
      { provider: "myfatoorah" },
    );
    expect(deactivated).toMatchObject({ provider: "myfatoorah", isActive: false });
    expect(connections.find((c) => c.provider === "myfatoorah")?.is_active).toBe(false);
    expect(audits.map((a) => a.p_action)).toEqual(["gateway.activate", "gateway.deactivate"]);
  });
});
