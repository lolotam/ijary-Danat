import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";

import type { WhatsappConnectionRow } from "@/integrations/supabase/database.types";
import { META_GRAPH_API_VERSION } from "@/whatsapp/cloudApi";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "99999999-9999-4999-8999-999999999999";
const CLOUD_ID = "33333333-3333-4333-8333-333333333333";
const TEST_MASTER_KEY = Buffer.alloc(32, 8).toString("base64");

const boundary = vi.hoisted(() => ({
  client: null as unknown,
  permissionAllowed: true,
  lookupResult: null as {
    id: string;
    company_id: string;
    method: "cloud_api" | "cloud_coexistence" | "evolution_qr";
    is_active: boolean;
    status: "connected" | "disconnected" | "pairing" | "error";
    instance_name: string | null;
    phone_number_id: string | null;
  } | null,
}));

vi.mock("@tanstack/react-start", () => {
  function makeFn() {
    const fn: any = async (args?: { data?: unknown; context?: unknown }) =>
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
    if (!boundary.permissionAllowed) {
      throw new Error("You do not have permission to manage the WhatsApp connection.");
    }
  }),
}));

vi.mock("@/company/companyClient.server", () => ({
  companyClient: () => boundary.client,
}));

vi.mock("@/company/requestCompany.server", () => ({
  requireRequestCompany: () => ({
    id: COMPANY_ID,
    slug: "acme",
    status: "active",
    host: "acme.ijary.app",
  }),
}));

vi.mock("@/platform/whatsappConnectionLookup.server", () => ({
  lookupActiveCloudConnectionByPhoneNumberId: vi.fn(async () => boundary.lookupResult),
}));

import {
  whatsappCompleteEmbeddedSignup,
  whatsappEmbeddedSignupConfig,
  whatsappSaveCloudCredentials,
} from "@/fns/whatsappSettings";

/**
 * عميل قاعدة بيانات وهمي لاختبار دوال خادم التسجيل المدمج وحفظ بيانات Cloud API.
 */
function createFakeDb() {
  const rows: WhatsappConnectionRow[] = [];
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
        const now = "2026-11-28T00:00:00.000Z";
        const row: WhatsappConnectionRow = {
          id: CLOUD_ID,
          company_id: pendingInsert.company_id as string,
          method: pendingInsert.method as WhatsappConnectionRow["method"],
          is_active: (pendingInsert.is_active as boolean) ?? false,
          status: (pendingInsert.status as WhatsappConnectionRow["status"]) ?? "disconnected",
          connected_number: null,
          instance_name: null,
          phone_number_id: (pendingInsert.phone_number_id as string | null) ?? null,
          waba_id: (pendingInsert.waba_id as string | null) ?? null,
          last_qr: null,
          last_seen_at: null,
          last_error: null,
          disconnect_alert_armed: false,
          disconnected_at: null,
          connected_at: (pendingInsert.connected_at as string | null) ?? null,
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
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(execute()).then(onFulfilled, onRejected),
    };
    return builder;
  }

  return {
    rows,
    secrets,
    from: vi.fn((table: "whatsapp_connections" | "company_secrets") => makeQuery(table)),
  };
}

describe("WhatsApp Embedded Signup server functions (T167)", () => {
  beforeEach(() => {
    boundary.permissionAllowed = true;
    boundary.lookupResult = null;
    boundary.client = createFakeDb();
    vi.stubEnv("INTEGRATIONS_MASTER_KEY", TEST_MASTER_KEY);
    vi.stubEnv("META_APP_ID", "app-1");
    vi.stubEnv("META_APP_SECRET", "secret-1");
    vi.stubEnv("META_EMBEDDED_SIGNUP_CONFIG_ID", "cfg-1");
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("returns public Embedded Signup config for authorized staff", async () => {
    const config = await whatsappEmbeddedSignupConfig({ data: { coexistence: true } });

    expect(config).toEqual({
      appId: "app-1",
      configId: "cfg-1",
      graphApiVersion: META_GRAPH_API_VERSION,
      extras: {
        featureType: "whatsapp_business_app_onboarding",
        sessionInfoVersion: "3",
      },
    });
  });

  it("rejects unauthorized staff when reading Embedded Signup config", async () => {
    boundary.permissionAllowed = false;

    await expect(whatsappEmbeddedSignupConfig({ data: { coexistence: true } })).rejects.toThrow(
      "permission",
    );
  });

  it("completes Embedded Signup, stores encrypted token, and returns summary without secrets", async () => {
    const fakeDb = createFakeDb();
    boundary.client = fakeDb;
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "EAAG_secret_token_7788" }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "109876543210" }] }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));

    const summary = await whatsappCompleteEmbeddedSignup({
      data: {
        code: "code-123",
        phoneNumberId: "109876543210",
        wabaId: "987654321098",
      },
    });

    expect(summary.isActive).toBe(true);
    expect(summary.status).toBe("connected");
    expect(JSON.stringify(summary)).not.toContain("EAAG_secret_token_7788");
    expect(fakeDb.secrets).toHaveLength(1);
    expect(fakeDb.secrets[0].last4).toBe("7788");
  });

  it("rejects support impersonation sessions on completion and manual save", async () => {
    const impersonationContext = {
      claims: { impersonator: "admin-1", impersonation_session: "sess-1" },
    };

    await expect(
      whatsappCompleteEmbeddedSignup({
        data: { code: "c", phoneNumberId: "123", wabaId: "456" },
        context: impersonationContext,
      } as never),
    ).rejects.toThrow("SUPPORT_SESSION_FORBIDDEN");

    await expect(
      whatsappSaveCloudCredentials({
        data: { phoneNumberId: "123", wabaId: "456", accessToken: "EAAG_12345" },
        context: impersonationContext,
      } as never),
    ).rejects.toThrow("SUPPORT_SESSION_FORBIDDEN");
  });

  it("propagates NUMBER_IN_USE when phoneNumberId belongs to another company", async () => {
    boundary.lookupResult = {
      id: "other-conn",
      company_id: OTHER_COMPANY_ID,
      method: "cloud_api",
      is_active: true,
      status: "connected",
      instance_name: null,
      phone_number_id: "109876543210",
    };

    await expect(
      whatsappCompleteEmbeddedSignup({
        data: { code: "c", phoneNumberId: "109876543210", wabaId: "456" },
      }),
    ).rejects.toMatchObject({ code: "NUMBER_IN_USE" });
  });

  test.each([
    { phoneNumberId: "", wabaId: "waba-1", accessToken: "EAAG_12345" },
    { phoneNumberId: "phone-1", wabaId: "", accessToken: "EAAG_12345" },
    { phoneNumberId: "phone-1", wabaId: "waba-1", accessToken: "   " },
  ])("validates manual Cloud API credentials with Zod: %o", async (payload) => {
    await expect(whatsappSaveCloudCredentials({ data: payload })).rejects.toThrow();
  });

  it("saves manual Cloud API credentials and returns summary without token", async () => {
    const fakeDb = createFakeDb();
    boundary.client = fakeDb;
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: "109876543210" }] }), { status: 200 }),
    );

    const summary = await whatsappSaveCloudCredentials({
      data: {
        phoneNumberId: "109876543210",
        wabaId: "987654321098",
        accessToken: "EAAG_manual_9012",
      },
    });

    expect(summary.method).toBe("cloud_api");
    expect(summary.isActive).toBe(true);
    expect(summary.status).toBe("connected");
    expect(JSON.stringify(summary)).not.toContain("EAAG_manual_9012");
    expect(fakeDb.secrets).toHaveLength(1);
    expect(fakeDb.secrets[0].last4).toBe("9012");
  });
});
