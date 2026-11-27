import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAdmin: true,
  createClient: vi.fn(),
  rpc: vi.fn(),
  getRequest: vi.fn(),
}));

vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: mocks.getRequest }));

import { platformOverview } from "./overview";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";

/** سطر الإجماليات كما ترده دالة قاعدة البيانات. */
const TOTALS = {
  companies_total: 3,
  companies_active: 2,
  companies_suspended: 1,
  units_total: 12,
  staff_users_total: 5,
  renters_total: 4,
  collected_this_month: 1250.5,
};

/** سطر حالة شركة كما ترده دالة قاعدة البيانات. */
const HEALTH = [
  {
    company_id: "22222222-2222-4222-8222-222222222222",
    slug: "healthy",
    name_ar: "شركة سليمة",
    name_en: "Healthy Co",
    status: "active",
    whatsapp_ok: true,
    gateway_ok: true,
    jobs_failed_24h: 0,
    notifications_failed_24h: 0,
  },
];

/**
 * يبني رمز جلسة يحمل ادعاء العامل الثاني، كما يفعل GoTrue.
 *
 * The subject is all the guard reads out of the token; the signature is never
 * checked here because the database checks it when the caller's own client
 * runs `is_platform_admin()`.
 */
function makeToken(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `header.${encoded}.signature`;
}

/** يوفّر طلباً بترويسة `Authorization` واحدة. */
function stubAuthorization(token: string | null): void {
  mocks.getRequest.mockReturnValue({
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "authorization" && token ? `Bearer ${token}` : null,
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SUPABASE_URL", "https://supabase.example.test");
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  mocks.isAdmin = true;
  mocks.createClient.mockReturnValue({ rpc: mocks.rpc });
  mocks.rpc.mockImplementation(async (name: string) => {
    if (name === "is_platform_admin") return { data: mocks.isAdmin, error: null };
    if (name === "platform_overview_totals") return { data: [TOTALS], error: null };
    return { data: HEALTH, error: null };
  });
  stubAuthorization(makeToken({ sub: ADMIN_ID, aal: "aal2" }));
});

describe("the platform overview operation (T186)", () => {
  it("refuses a caller who is not a platform admin before any database read", async () => {
    mocks.isAdmin = false;

    await expect(platformOverview()).rejects.toThrow("PLATFORM_ADMIN_REQUIRED");
    expect(mocks.rpc).not.toHaveBeenCalledWith("platform_overview_totals");
    expect(mocks.rpc).not.toHaveBeenCalledWith("platform_company_health");
  });

  it("reads the totals and the health of every company", async () => {
    const overview = await platformOverview();

    expect(overview.totals).toEqual(TOTALS);
    expect(overview.companies).toEqual(HEALTH);
  });

  it("asks the database through the caller's own token, not through the service role", async () => {
    await platformOverview();

    expect(mocks.createClient).toHaveBeenCalledWith(
      "https://supabase.example.test",
      "publishable-key",
      expect.objectContaining({
        global: {
          headers: { Authorization: `Bearer ${makeToken({ sub: ADMIN_ID, aal: "aal2" })}` },
        },
      }),
    );
    expect(mocks.rpc).toHaveBeenCalledWith("platform_overview_totals");
    expect(mocks.rpc).toHaveBeenCalledWith("platform_company_health");
  });

  it("refuses a request that carries no bearer token", async () => {
    stubAuthorization(null);

    await expect(platformOverview()).rejects.toThrow("PLATFORM_ADMIN_REQUIRED");
    expect(mocks.rpc).not.toHaveBeenCalledWith("platform_overview_totals");
  });

  it("reports a failed read instead of an empty overview", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "is_platform_admin") return { data: true, error: null };
      return { data: null, error: { message: "permission denied" } };
    });

    await expect(platformOverview()).rejects.toThrow(
      "platform_overview_totals failed: permission denied",
    );
  });

  it("refuses an overview whose totals row is missing", async () => {
    mocks.rpc.mockImplementation(async (name: string) => {
      if (name === "is_platform_admin") return { data: true, error: null };
      if (name === "platform_overview_totals") return { data: [], error: null };
      return { data: HEALTH, error: null };
    });

    await expect(platformOverview()).rejects.toThrow("platform_overview_totals returned no row");
  });
});
