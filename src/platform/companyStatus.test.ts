import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  callerRpc: vi.fn(),
  getRequest: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: mocks.getRequest }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: { from: mocks.from },
}));

import { platformSetCompanyStatus } from "./companyStatus";
import { COMPANY_NOT_FOUND } from "./companyStaffAccount";
import { PLATFORM_ADMIN_REQUIRED } from "./requirePlatformAdmin.server";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

/** نتيجة استعلام واحد: ما يرد به، وخطأه إن وُجد. */
interface QueryOutcome {
  data?: unknown;
  error?: { message: string } | null;
}

/** كتابة واحدة سجّلها الاستعلام الوهمي. */
interface RecordedWrite {
  table: string;
  method: string;
  payload?: unknown;
}

/**
 * يثبّت قاعدة بيانات وهمية: تحفظ كل كتابة وتردّ بما يحدده الاختبار.
 *
 * The responses are keyed by `table:method` because one table is read and
 * written in different shapes inside the same operation.
 */
function installFakeDatabase(responses: Record<string, QueryOutcome> = {}): {
  writes: RecordedWrite[];
} {
  const writes: RecordedWrite[] = [];
  const outcomeFor = (key: string): QueryOutcome => responses[key] ?? { data: null, error: null };

  mocks.from.mockImplementation((table: string) => {
    let writeMethod: string | null = null;
    const chain: Record<string, unknown> = {};

    for (const method of ["select", "insert", "update", "delete", "eq"]) {
      chain[method] = vi.fn((...args: unknown[]) => {
        if (method === "insert" || method === "update" || method === "delete") {
          writeMethod = method;
          writes.push({ table, method, payload: args[0] });
        }
        return chain;
      });
    }

    const result = () => {
      const outcome = outcomeFor(`${table}:${writeMethod ?? "select"}`);
      return Promise.resolve({
        data: outcome.data ?? null,
        error: outcome.error ?? null,
        count: null,
      });
    };

    chain.single = vi.fn(result);
    chain.maybeSingle = vi.fn(result);
    chain.then = (onFulfilled: unknown, onRejected: unknown) =>
      result().then(
        onFulfilled as (value: unknown) => unknown,
        onRejected as (reason: unknown) => unknown,
      );

    return chain;
  });

  return { writes };
}

/** يكتب الاختبار على الجدول نفسه أكثر من مرة؛ هذا يختار واحدة بعينها. */
function writeTo(
  writes: RecordedWrite[],
  table: string,
  method: string,
): RecordedWrite | undefined {
  return writes.find((write) => write.table === table && write.method === method);
}

/** صف شركة نشطة كما تقرأه العملية. */
const ACTIVE_COMPANY = {
  id: COMPANY_ID,
  slug: "acme",
  status: "active",
  suspended_at: null,
  suspended_reason: null,
  suspended_by: null,
};

/** صف شركة موقوفة كما تقرأه العملية. */
const SUSPENDED_COMPANY = {
  id: COMPANY_ID,
  slug: "acme",
  status: "suspended",
  suspended_at: "2026-01-05T09:00:00.000Z",
  suspended_reason: "لم تدفع الاشتراك",
  suspended_by: ADMIN_ID,
};

describe("the platform company status operation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));
    vi.stubEnv("SUPABASE_URL", "https://supabase.example.test");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "publishable-key");

    const token = `header.${Buffer.from(
      JSON.stringify({ sub: ADMIN_ID, aal: "aal2" }),
      "utf8",
    ).toString("base64url")}.signature`;

    mocks.getRequest.mockReturnValue({
      headers: {
        get: (name: string) => (name.toLowerCase() === "authorization" ? `Bearer ${token}` : null),
      },
    });
    mocks.createClient.mockReturnValue({ rpc: mocks.callerRpc });
    mocks.callerRpc.mockResolvedValue({ data: true, error: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("suspends the company and records who stopped it and why", async () => {
    const { writes } = installFakeDatabase({
      "companies:select": { data: ACTIVE_COMPANY },
      "companies:update": {
        data: {
          ...ACTIVE_COMPANY,
          status: "suspended",
          suspended_at: "2026-02-01T00:00:00.000Z",
          suspended_reason: "لم تدفع الاشتراك",
          suspended_by: ADMIN_ID,
        },
      },
    });

    await platformSetCompanyStatus({
      companyId: COMPANY_ID,
      status: "suspended",
      reason: "  لم تدفع الاشتراك  ",
    });

    expect(writeTo(writes, "companies", "update")?.payload).toEqual({
      status: "suspended",
      suspended_at: "2026-02-01T00:00:00.000Z",
      suspended_reason: "لم تدفع الاشتراك",
      suspended_by: ADMIN_ID,
    });
  });

  it("clears the suspension columns when the company is reactivated", async () => {
    const { writes } = installFakeDatabase({
      "companies:select": { data: SUSPENDED_COMPANY },
      "companies:update": {
        data: {
          ...SUSPENDED_COMPANY,
          status: "active",
          suspended_at: null,
          suspended_reason: null,
          suspended_by: null,
        },
      },
    });

    await platformSetCompanyStatus({
      companyId: COMPANY_ID,
      status: "active",
      reason: "سُددت الاشتراك",
    });

    expect(writeTo(writes, "companies", "update")?.payload).toEqual({
      status: "active",
      suspended_at: null,
      suspended_reason: null,
      suspended_by: null,
    });
  });

  it("writes one audit row carrying the state before and after", async () => {
    const { writes } = installFakeDatabase({
      "companies:select": { data: ACTIVE_COMPANY },
      "companies:update": {
        data: {
          ...ACTIVE_COMPANY,
          status: "suspended",
          suspended_at: "2026-02-01T00:00:00.000Z",
          suspended_reason: "لم تدفع الاشتراك",
          suspended_by: ADMIN_ID,
        },
      },
    });

    await platformSetCompanyStatus({
      companyId: COMPANY_ID,
      status: "suspended",
      reason: "لم تدفع الاشتراك",
    });

    const audits = writes.filter((write) => write.table === "platform_audit_log");
    expect(audits).toHaveLength(1);
    expect(audits[0].payload).toMatchObject({
      action: "company.status.update",
      entity: "company",
      entity_id: COMPANY_ID,
      company_id: COMPANY_ID,
      actor_id: ADMIN_ID,
      before: { status: "active", suspended_reason: null },
      after: { status: "suspended", suspended_reason: "لم تدفع الاشتراك" },
    });
  });

  it("refuses a caller that is not a platform admin", async () => {
    installFakeDatabase();
    mocks.callerRpc.mockResolvedValue({ data: false, error: null });

    await expect(
      platformSetCompanyStatus({
        companyId: COMPANY_ID,
        status: "suspended",
        reason: "لم تدفع الاشتراك",
      }),
    ).rejects.toThrow(PLATFORM_ADMIN_REQUIRED);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("refuses a company that does not exist", async () => {
    installFakeDatabase({ "companies:select": { data: null } });

    await expect(
      platformSetCompanyStatus({
        companyId: COMPANY_ID,
        status: "suspended",
        reason: "لم تدفع الاشتراك",
      }),
    ).rejects.toThrow(COMPANY_NOT_FOUND);
  });

  it("leaves a company that is already in that state alone, and audits nothing", async () => {
    const { writes } = installFakeDatabase({ "companies:select": { data: ACTIVE_COMPANY } });

    await expect(
      platformSetCompanyStatus({
        companyId: COMPANY_ID,
        status: "active",
        reason: "لم تتغير شيئاً",
      }),
    ).resolves.toEqual({ companyId: COMPANY_ID, status: "active" });
    expect(writeTo(writes, "companies", "update")).toBeUndefined();
    expect(writes.filter((write) => write.table === "platform_audit_log")).toHaveLength(0);
  });

  it.each([
    ["أقصر من الحد الأدنى", "ab"],
    ["أطول من الحد الأقصى", "س".repeat(501)],
  ])("refuses a reason %s", async (_label, reason) => {
    const { writes } = installFakeDatabase({ "companies:select": { data: ACTIVE_COMPANY } });

    await expect(
      platformSetCompanyStatus({ companyId: COMPANY_ID, status: "suspended", reason }),
    ).rejects.toThrow(/reason/);
    expect(writeTo(writes, "companies", "update")).toBeUndefined();
  });
});
