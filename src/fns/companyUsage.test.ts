import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

/**
 * عميل Supabase الذي يمرّر companyClient — الحدّ الفاصل الذي يُحاكى هنا.
 *
 * The builder is thenable so `await` sees the prepared PostgREST result, and it
 * records the filters the server function chose — especially the month key.
 */
const mocks = vi.hoisted(() => ({
  results: {} as Record<string, unknown>,
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
}));

vi.mock("@tanstack/react-start", () => {
  function makeFn() {
    const fn: any = (data: any) => fn._handler({ data, context: fn._context });
    fn.middleware = vi.fn().mockReturnValue(fn);
    fn.validator = vi.fn().mockReturnValue(fn);
    fn.handler = vi.fn().mockImplementation((handler: any) => {
      fn._handler = async (args: any) => handler({ ...args, data: args.data });
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
  companyClient: () => ({
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "in", "maybeSingle"]) {
        builder[method] = (...args: unknown[]) => {
          mocks.calls.push({ table, method, args });
          return builder;
        };
      }
      builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(mocks.results[table]).then(resolve, reject);
      return builder;
    },
  }),
}));

vi.mock("@/company/requestCompany.server", () => ({
  requireRequestCompany: () => ({
    id: COMPANY_ID,
    slug: "acme",
    status: "active",
    host: "acme.localhost",
  }),
}));

import { companyUsage, type CompanyUsage } from "@/fns/companyUsage";

/** سياق مستخدم مسموح له بقراءة الإعدادات. */
const ALLOWED_CONTEXT = {
  userId: "user-1",
  supabase: {
    rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
  },
};

/** يستدعي دالة الخادم الوهمية في سياق مستخدم مسموح. */
function readUsage(): Promise<CompanyUsage> {
  const fn = companyUsage as unknown as {
    _context: unknown;
    (input?: unknown): Promise<CompanyUsage>;
  };
  fn._context = ALLOWED_CONTEXT;
  return fn();
}

/** يعيد ضبط نتائج الجداول إلى الحالة الفارغة قبل كل سيناريو. */
function resetResults(): void {
  mocks.results = {
    company_limits: { data: null, error: null },
    units: { data: null, count: 0, error: null },
    profiles: { data: [], error: null },
    user_roles: { data: [], error: null },
    company_usage_monthly: { data: null, error: null },
    company_storage_usage: { data: null, error: null },
  };
  mocks.calls = [];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  // 30 November 22:30 UTC is already 1 December in Kuwait.
  vi.setSystemTime(new Date("2026-11-30T22:30:00.000Z"));
  resetResults();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("companyUsage (T131)", () => {
  it("reads the Kuwait month and counts only active profiles with a staff role", async () => {
    mocks.results.company_limits = {
      data: {
        max_units: 10,
        max_staff_users: 2,
        max_whatsapp_per_month: 50,
        max_storage_bytes: 500,
      },
      error: null,
    };
    mocks.results.units = { data: null, count: 7, error: null };
    mocks.results.profiles = {
      data: [{ id: "p1" }, { id: "p2" }, { id: "p3" }],
      error: null,
    };
    mocks.results.user_roles = {
      data: [{ user_id: "p1" }, { user_id: "p1" }, { user_id: "p2" }],
      error: null,
    };
    mocks.results.company_usage_monthly = { data: { whatsapp_sent: 41 }, error: null };
    mocks.results.company_storage_usage = { data: { bytes: 123 }, error: null };

    expect(await readUsage()).toEqual({
      units: { used: 7, limit: 10 },
      staff: { used: 2, limit: 2 },
      whatsapp: { used: 41, limit: 50 },
      storage: { used: 123, limit: 500 },
    });
    expect(
      mocks.calls.some(
        (call) =>
          call.table === "company_usage_monthly" &&
          call.method === "eq" &&
          call.args.includes("2026-12-01"),
      ),
    ).toBe(true);
    expect(mocks.calls.some((call) => call.table === "user_roles" && call.method === "in")).toBe(
      true,
    );
    expect(
      mocks.calls.filter((call) => call.method === "eq" && call.args[0] === "company_id"),
    ).toHaveLength(6);
  });

  it("returns zeros and unlimited ceilings when no usage or limits row exists", async () => {
    expect(await readUsage()).toEqual({
      units: { used: 0, limit: null },
      staff: { used: 0, limit: null },
      whatsapp: { used: 0, limit: null },
      storage: { used: 0, limit: null },
    });
  });

  it("keeps a zero ceiling distinct from an unlimited one", async () => {
    mocks.results.company_limits = {
      data: {
        max_units: 0,
        max_staff_users: 0,
        max_whatsapp_per_month: 0,
        max_storage_bytes: 0,
      },
      error: null,
    };

    expect(await readUsage()).toEqual({
      units: { used: 0, limit: 0 },
      staff: { used: 0, limit: 0 },
      whatsapp: { used: 0, limit: 0 },
      storage: { used: 0, limit: 0 },
    });
  });

  it.each([
    ["company_limits", "company_limits lookup failed: permission denied"],
    ["units", "units count failed: permission denied"],
    ["company_storage_usage", "company_storage_usage lookup failed: permission denied"],
  ])("propagates a failed %s read instead of returning partial usage", async (table, message) => {
    mocks.results[table] = { data: null, error: { message: "permission denied" } };

    await expect(readUsage()).rejects.toThrow(message);
  });
});
