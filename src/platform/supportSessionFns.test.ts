import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * أغلفة دوال الخادم لجلسة الدعم: رفض الرمز الذي يخصّ شركة أخرى، وقراءة سياق
 * الجلسة المفتوحة، وإنهائها مع توثيقه في سجل المنصة.
 */

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  from: vi.fn(),
  getRequest: vi.fn(),
  getSession: vi.fn(),
}));

// The server-fn chain is a framework boundary: the test calls the handler
// directly instead of going through the RPC transport.
vi.mock("@tanstack/react-start", () => {
  function makeFn() {
    const fn: any = (options: any) =>
      fn._handler({ data: fn._validator(options?.data), context: fn._context });
    fn.middleware = vi.fn().mockReturnValue(fn);
    fn.validator = vi.fn().mockImplementation((validator: unknown) => {
      fn._validator = validator;
      return fn;
    });
    fn.handler = vi.fn().mockImplementation((handler: unknown) => {
      fn._handler = handler;
      return fn;
    });
    return fn;
  }
  return { createServerFn: vi.fn().mockImplementation(() => makeFn()) };
});

vi.mock("@tanstack/react-start/server", () => ({ getRequest: mocks.getRequest }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: mocks.getSession } },
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from },
}));

import { runWithRequestCompany } from "@/company/requestCompany.server";
import { supportSession as arSupport } from "@/i18n/locales/ar/supportSession";
import {
  supportSessionErrorMessage,
  supportSessionLink,
  verifySupportToken,
} from "@/platform/supportSessionFns";
import {
  acceptSupportSessionToken,
  endSupportSessionFromPanel,
  readSupportSessionContext,
} from "@/platform/supportSessionFns";

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
 * يبني قاعدة بيانات وهمية تسجل عمليات الكتابة وتُعيد النتيجة المحددة لكل جدول.
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

/**
 * يوقّع رمز جلسة دعم كما يوقّعه `supportSession.ts`.
 */
async function mintSupportToken(claims: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({
    role: "authenticated",
    aud: "authenticated",
    aal: "aal1",
    sub: TARGET_USER_ID,
    impersonator: ADMIN_ID,
    impersonation_session: SESSION_ID,
    ...claims,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(TEST_JWT_SECRET));
}

/**
 * صف جلسة انتحال مفتوحة.
 */
function openSessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    company_id: COMPANY_ID,
    target_user_id: TARGET_USER_ID,
    reason: "Check the invoices",
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ended_at: null,
    ...overrides,
  };
}

/**
 * ينفّذ عملية داخل سياق شركة الطلب.
 */
function asCompany<T>(companyId: string, run: () => Promise<T>): Promise<T> {
  return runWithRequestCompany(
    { id: companyId, slug: "acme", status: "active", host: "acme.ijary.app" },
    run,
  );
}

/**
 * يترجم بمفاتيح شريحة الدعم، قبل ربطها بكتالوج الترجمة العام.
 */
const translate = (key: string): string => arSupport[key] ?? key;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SUPABASE_JWT_SECRET = TEST_JWT_SECRET;
  mocks.getSession.mockResolvedValue({
    data: { session: { access_token: "caller-token" } },
  });
  mocks.getRequest.mockReturnValue(
    new Request("https://acme.ijary.app/admin", {
      headers: { Authorization: "Bearer caller-token" },
    }),
  );
});

afterEach(() => {
  delete process.env.SUPABASE_JWT_SECRET;
});

describe("support session link", () => {
  it("keeps the token in the fragment instead of the query string", () => {
    const link = supportSessionLink("https://acme.ijary.app", "tok en");

    expect(link).toBe("https://acme.ijary.app/support-session#token=tok%20en");
    expect(link).not.toContain("?");
  });
});

describe("support session refusal messages", () => {
  it("turns a refusal code into its sentence and anything else into the generic one", () => {
    expect(supportSessionErrorMessage(translate, new Error("SUPPORT_SESSION_NOT_FOUND"))).toBe(
      arSupport["supportSession.error.SUPPORT_SESSION_NOT_FOUND"],
    );

    expect(supportSessionErrorMessage(translate, new Error("connection reset"))).toBe(
      arSupport["supportSession.platform.error.generic"],
    );
  });
});

describe("support token verification", () => {
  it("reads the claims of a token signed by the platform", async () => {
    const claims = await verifySupportToken(await mintSupportToken());

    expect(claims).toEqual({
      targetUserId: TARGET_USER_ID,
      impersonatorId: ADMIN_ID,
      sessionId: SESSION_ID,
    });
  });

  it("refuses a token signed with another secret", async () => {
    const forged = await new SignJWT({
      role: "authenticated",
      sub: TARGET_USER_ID,
      impersonator: ADMIN_ID,
      impersonation_session: SESSION_ID,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("another-secret-with-at-least-thirty-two-chars"));

    expect(await verifySupportToken(forged)).toBeNull();
  });

  it("refuses a token without the impersonation claims", async () => {
    const plain = await new SignJWT({ role: "authenticated", sub: TARGET_USER_ID })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(TEST_JWT_SECRET));

    expect(await verifySupportToken(plain)).toBeNull();
  });
});

describe("accepting a support token on the company host", () => {
  it("refuses a token whose session belongs to another company", async () => {
    installFakeDb({
      "impersonation_sessions:select": { data: openSessionRow({ company_id: OTHER_COMPANY_ID }) },
    });

    const result = await asCompany(COMPANY_ID, async () =>
      acceptSupportSessionToken({ token: await mintSupportToken() }),
    );

    expect(result).toEqual({ accepted: false });
  });

  it("accepts a token whose session is open for this company", async () => {
    installFakeDb({ "impersonation_sessions:select": { data: openSessionRow() } });

    const result = await asCompany(COMPANY_ID, async () =>
      acceptSupportSessionToken({ token: await mintSupportToken() }),
    );

    expect(result).toEqual({ accepted: true });
  });
});

describe("reading the support session inside the company panel", () => {
  it("names the platform admin and the reason of an open session", async () => {
    installFakeDb({
      "impersonation_sessions:select": { data: openSessionRow() },
      "platform_admins:select": { data: { full_name: "دعم المنصة" } },
    });
    mocks.getRequest.mockReturnValue(
      new Request("https://acme.ijary.app/admin", {
        headers: { Authorization: `Bearer ${await mintSupportToken()}` },
      }),
    );

    const context = await asCompany(COMPANY_ID, () => readSupportSessionContext());

    expect(context).toMatchObject({
      active: true,
      sessionId: SESSION_ID,
      reason: "Check the invoices",
      adminName: "دعم المنصة",
    });
  });

  it("reports no session once it is ended", async () => {
    installFakeDb({
      "impersonation_sessions:select": {
        data: openSessionRow({ ended_at: new Date().toISOString() }),
      },
    });
    mocks.getRequest.mockReturnValue(
      new Request("https://acme.ijary.app/admin", {
        headers: { Authorization: `Bearer ${await mintSupportToken()}` },
      }),
    );

    const context = await asCompany(COMPANY_ID, () => readSupportSessionContext());

    expect(context).toEqual({ active: false });
  });
});

describe("ending a support session from the company panel", () => {
  it("ends the session the token names and audits it", async () => {
    const { writes } = installFakeDb({
      "impersonation_sessions:select": { data: openSessionRow() },
      "impersonation_sessions:update": { data: null },
      "platform_audit_log:insert": { data: null },
    });
    mocks.getRequest.mockReturnValue(
      new Request("https://acme.ijary.app/admin", {
        headers: { Authorization: `Bearer ${await mintSupportToken()}` },
      }),
    );

    const result = await asCompany(COMPANY_ID, () => endSupportSessionFromPanel());

    expect(result.sessionId).toBe(SESSION_ID);
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
            entity_id: SESSION_ID,
            company_id: COMPANY_ID,
            actor_id: ADMIN_ID,
          }),
        }),
      ]),
    );
  });

  it("refuses to end a session the token does not name", async () => {
    installFakeDb({ "impersonation_sessions:select": { data: null } });
    mocks.getRequest.mockReturnValue(
      new Request("https://acme.ijary.app/admin", {
        headers: { Authorization: `Bearer ${await mintSupportToken()}` },
      }),
    );

    await expect(asCompany(COMPANY_ID, () => endSupportSessionFromPanel())).rejects.toThrow(
      "SUPPORT_SESSION_NOT_FOUND",
    );
  });
});
