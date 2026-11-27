import { jwtVerify } from "jose";
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  callerRpc: vi.fn(),
  getRequest: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: mocks.getRequest }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: mocks.from,
  },
}));

import { assertNotSupportSession } from "@/company/supportSessionGuard";
import {
  platformEndSupportSession,
  platformStartSupportSession,
  SUPPORT_SESSION_NOT_FOUND,
  TARGET_USER_NOT_IN_COMPANY,
} from "@/platform/supportSession";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_COMPANY_ID = "33333333-3333-4333-8333-333333333333";
const TARGET_USER_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_ID = "55555555-5555-4555-8555-555555555555";
const TEST_JWT_SECRET = "test-jwt-secret-with-at-least-thirty-two-chars";

interface QueryOutcome {
  data?: unknown;
  error?: { message: string } | null;
}

interface RecordedWrite {
  table: string;
  method: string;
  payload: unknown;
}

/**
 * يبني رمز وصول مزيّفاً للمشرف يحمل معرّفه في `sub` لاجتياز `requirePlatformAdmin`.
 */
function makeAdminJwt(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub, aal: "aal2" })).toString("base64url");
  return `${header}.${payload}.sig`;
}

/**
 * يثبّت قاعدة بيانات وهمية تسجل عمليات الكتابة وتُعيد النتائج المحددة لكل جدول وعملية.
 */
function installFakeDb(outcomes: Record<string, QueryOutcome>): { writes: RecordedWrite[] } {
  const writes: RecordedWrite[] = [];

  mocks.from.mockImplementation((table: string) => {
    let writeMethod: string | null = null;
    const chain: Record<string, unknown> = {};

    for (const method of ["select", "insert", "update", "eq", "is"]) {
      chain[method] = vi.fn((...args: unknown[]) => {
        if (method === "insert" || method === "update") {
          writeMethod = method;
          writes.push({ table, method, payload: args[0] });
        }
        return chain;
      });
    }

    const resolveOutcome = () => {
      const outcome = outcomes[`${table}:${writeMethod ?? "select"}`] ?? {
        data: null,
        error: null,
      };
      return Promise.resolve({ data: outcome.data ?? null, error: outcome.error ?? null });
    };

    chain.single = vi.fn(resolveOutcome);
    chain.maybeSingle = vi.fn(resolveOutcome);
    chain.then = (onFulfilled: unknown, onRejected: unknown) =>
      resolveOutcome().then(
        onFulfilled as (v: unknown) => unknown,
        onRejected as (e: unknown) => unknown,
      );

    return chain;
  });

  return { writes };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SUPABASE_URL = "https://supabase.test.local";
  process.env.SUPABASE_PUBLISHABLE_KEY = "test-publishable-key";
  process.env.SUPABASE_JWT_SECRET = TEST_JWT_SECRET;
  process.env.PLATFORM_ROOT_HOST = "ijary.app";

  mocks.getRequest.mockReturnValue(
    new Request("https://admin.ijary.app/platform/support", {
      headers: { Authorization: `Bearer ${makeAdminJwt(ADMIN_ID)}` },
    }),
  );
  mocks.createClient.mockReturnValue({ rpc: mocks.callerRpc });
  mocks.callerRpc.mockResolvedValue({ data: true, error: null });
});

afterEach(() => {
  delete process.env.SUPABASE_JWT_SECRET;
  delete process.env.PLATFORM_ROOT_HOST;
});

describe("support session lifecycle (T176)", () => {
  test.each(["", "   ", "\n\t"])("start refused without a reason (%j)", async (blankReason) => {
    await expect(
      platformStartSupportSession({
        companyId: COMPANY_ID,
        targetUserId: TARGET_USER_ID,
        reason: blankReason,
      }),
    ).rejects.toThrow(/reason/i);

    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("start refused for a suspended company", async () => {
    installFakeDb({
      "companies:select": {
        data: { id: COMPANY_ID, slug: "acme", status: "suspended" },
      },
    });

    await expect(
      platformStartSupportSession({
        companyId: COMPANY_ID,
        targetUserId: TARGET_USER_ID,
        reason: "Check invoices",
      }),
    ).rejects.toThrow(/suspended/i);
  });

  test.each([
    { label: "missing profile", profile: null },
    {
      label: "profile in another company",
      profile: { id: TARGET_USER_ID, company_id: OTHER_COMPANY_ID, is_active: true },
    },
    {
      label: "inactive profile in target company",
      profile: { id: TARGET_USER_ID, company_id: COMPANY_ID, is_active: false },
    },
  ])("start refused when target user is $label", async ({ profile }) => {
    installFakeDb({
      "companies:select": {
        data: { id: COMPANY_ID, slug: "acme", status: "active" },
      },
      "profiles:select": {
        data: profile,
      },
    });

    await expect(
      platformStartSupportSession({
        companyId: COMPANY_ID,
        targetUserId: TARGET_USER_ID,
        reason: "Check invoices",
      }),
    ).rejects.toThrow(TARGET_USER_NOT_IN_COMPANY);
  });

  it("start creates session, mints a 60-minute impersonation JWT, and audits the start", async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const { writes } = installFakeDb({
      "companies:select": {
        data: { id: COMPANY_ID, slug: "acme", status: "active" },
      },
      "profiles:select": {
        data: { id: TARGET_USER_ID, company_id: COMPANY_ID, is_active: true },
      },
      "impersonation_sessions:insert": {
        data: { id: SESSION_ID, expires_at: expiresAt },
      },
      "platform_audit_log:insert": { data: null },
    });

    const result = await platformStartSupportSession({
      companyId: COMPANY_ID,
      targetUserId: TARGET_USER_ID,
      reason: "Help configure gateway",
    });

    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.expiresAt).toBe(expiresAt);
    expect(result.companyHost).toBe("acme.ijary.app");

    const verified = await jwtVerify(result.token, new TextEncoder().encode(TEST_JWT_SECRET));
    expect(verified.payload).toMatchObject({
      role: "authenticated",
      sub: TARGET_USER_ID,
      aal: "aal1",
      impersonator: ADMIN_ID,
      impersonation_session: SESSION_ID,
    });
    expect(verified.payload.exp).toBeTypeOf("number");
    expect(verified.payload.iat).toBeTypeOf("number");
    expect((verified.payload.exp as number) - (verified.payload.iat as number)).toBe(3600);

    expect(writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "impersonation_sessions",
          method: "insert",
          payload: expect.objectContaining({
            platform_admin_id: ADMIN_ID,
            company_id: COMPANY_ID,
            target_user_id: TARGET_USER_ID,
            reason: "Help configure gateway",
          }),
        }),
        expect.objectContaining({
          table: "platform_audit_log",
          method: "insert",
          payload: expect.objectContaining({
            action: "support_session.start",
            entity: "impersonation_session",
            entity_id: SESSION_ID,
            company_id: COMPANY_ID,
            actor_id: ADMIN_ID,
          }),
        }),
      ]),
    );
  });

  it("end marks ended_at and writes a platform audit row", async () => {
    const { writes } = installFakeDb({
      "impersonation_sessions:select": {
        data: {
          id: SESSION_ID,
          company_id: COMPANY_ID,
          target_user_id: TARGET_USER_ID,
          ended_at: null,
        },
      },
      "impersonation_sessions:update": { data: null },
      "platform_audit_log:insert": { data: null },
    });

    const result = await platformEndSupportSession({ sessionId: SESSION_ID });

    expect(result.sessionId).toBe(SESSION_ID);
    expect(result.endedAt).toBeTruthy();

    expect(writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "impersonation_sessions",
          method: "update",
          payload: { ended_at: result.endedAt },
        }),
        expect.objectContaining({
          table: "platform_audit_log",
          method: "insert",
          payload: expect.objectContaining({
            action: "support_session.end",
            entity: "impersonation_session",
            entity_id: SESSION_ID,
            company_id: COMPANY_ID,
            actor_id: ADMIN_ID,
          }),
        }),
      ]),
    );
  });

  it("end refuses when session does not exist", async () => {
    installFakeDb({
      "impersonation_sessions:select": { data: null },
    });

    await expect(platformEndSupportSession({ sessionId: SESSION_ID })).rejects.toThrow(
      SUPPORT_SESSION_NOT_FOUND,
    );
  });
});

describe("assertNotSupportSession guard (T176)", () => {
  it("refuses with SUPPORT_SESSION_FORBIDDEN when impersonator claim is present", () => {
    expect(() => assertNotSupportSession({ impersonator: ADMIN_ID })).toThrow(
      "SUPPORT_SESSION_FORBIDDEN",
    );
  });

  test.each([undefined, null, {}, { sub: TARGET_USER_ID }, { impersonator: "" }])(
    "allows normal session claims (%j)",
    (claims) => {
      expect(() => assertNotSupportSession(claims)).not.toThrow();
    },
  );
});
