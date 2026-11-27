import { beforeEach, describe, expect, it, vi } from "vitest";

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

/**
 * حالة قاعدة البيانات و Cloudflare كما تراها العملية أثناء الاختبار.
 */
const mocks = vi.hoisted(() => ({
  isAdmin: true,
  domains: [] as Array<Record<string, unknown>>,
  auditWrites: [] as Array<Record<string, unknown>>,
  insertError: null as { message: string } | null,
  updateError: null as { message: string } | null,
  listError: null as { message: string } | null,
  fetchCalls: [] as Array<{ url: string; method: string; body: unknown }>,
  fetchStatus: 200,
  fetchBody: null as unknown,
}));

vi.mock("./requirePlatformAdmin.server", () => ({
  requirePlatformAdmin: async () => {
    if (!mocks.isAdmin) throw new Error("PLATFORM_ADMIN_REQUIRED");
    return { userId: ADMIN_ID };
  },
}));

/**
 * بديل Supabase يسجّل ما كُتب ويقرأ ما حُضّر له.
 *
 * The chain mirrors the one the operations walk: `select`/`eq`/`order` for the
 * reads, `insert`/`update` followed by `select`/`single` for the writes.
 */
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      let payload: Record<string, unknown> | null = null;
      const builder: Record<string, unknown> = {};

      builder.select = () => builder;
      builder.eq = (column: string, value: unknown) => {
        filters[column] = value;
        return builder;
      };
      builder.order = async () => ({
        data: mocks.listError ? null : mocks.domains.filter((row) => matches(row, filters)),
        error: mocks.listError,
      });
      builder.maybeSingle = async () => {
        const found = mocks.domains.find((row) => matches(row, filters)) ?? null;
        return { data: found, error: null };
      };
      builder.single = async () => {
        if (table === "company_domains" && mocks.insertError) {
          return { data: null, error: mocks.insertError };
        }
        if (table === "company_domains" && mocks.updateError) {
          return { data: null, error: mocks.updateError };
        }
        const row = { ...(payload ?? {}), id: "44444444-4444-4444-8444-444444444444" };
        if (table === "company_domains") mocks.domains.push(row);
        return { data: row, error: null };
      };
      builder.insert = (next: Record<string, unknown>) => {
        payload = next;
        if (table === "platform_audit_log") mocks.auditWrites.push(next);
        return builder;
      };
      builder.update = (next: Record<string, unknown>) => {
        payload = next;
        return builder;
      };
      builder.then = (resolve: (value: unknown) => unknown) =>
        resolve({ data: null, error: null }) as unknown as void;

      return builder;
    },
  },
}));

/**
 * يطابق صفاً مع شروط الاستعلام.
 */
function matches(row: Record<string, unknown>, filters: Record<string, unknown>): boolean {
  return Object.entries(filters).every(([column, value]) => row[column] === value);
}

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const builder: Record<string, unknown> = {};
    let validator: ((data: unknown) => unknown) | null = null;
    builder.validator = (next: (data: unknown) => unknown) => {
      validator = next;
      return builder;
    };
    builder.handler = (handler: (context: { data: unknown }) => unknown) => {
      return async (options: { data: unknown }) => {
        const data = validator ? validator(options.data) : options.data;
        return handler({ data });
      };
    };
    return builder;
  },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) } },
}));

import {
  platformAddCustomDomain,
  platformListCompanyDomains,
  platformVerifyCustomDomain,
} from "./domains";

/**
 * صف نطاق مخصّص كما يحفظه الجدول.
 */
function domainRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    company_id: COMPANY_ID,
    host: "www.acme.com",
    kind: "custom",
    is_primary: false,
    verification_status: "pending",
    provider_ref: "cf-hostname-1",
    verification_records: null,
    last_checked_at: null,
    created_at: "2026-11-27T10:00:00.000Z",
    updated_at: "2026-11-27T10:00:00.000Z",
    ...overrides,
  };
}

/**
 * جواب Cloudflare لنطاق مخصّص.
 */
function cloudflareResult(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    result: {
      id: "cf-hostname-1",
      hostname: "www.acme.com",
      status: "pending",
      custom_origin_server: "acme.ijary.app",
      ownership_verification: {
        name: "_cf-custom-hostname.www.acme.com",
        type: "txt",
        value: "token-123",
      },
      ssl: { status: "pending_validation" },
      ...overrides,
    },
  };
}

/**
 * يضع جواب Cloudflare المطلوب في الطلب التالي.
 */
function cloudflareResponds(status: number, body: unknown): void {
  mocks.fetchStatus = status;
  mocks.fetchBody = body;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isAdmin = true;
  mocks.domains = [];
  mocks.auditWrites = [];
  mocks.insertError = null;
  mocks.updateError = null;
  mocks.listError = null;
  mocks.fetchCalls = [];
  mocks.fetchStatus = 200;
  mocks.fetchBody = cloudflareResult();

  vi.stubEnv("CLOUDFLARE_API_TOKEN", "cf-token");
  vi.stubEnv("CLOUDFLARE_ZONE_ID", "zone-123");
  vi.stubEnv("PLATFORM_ROOT_HOST", "ijary.app");
  vi.stubEnv("PLATFORM_ADMIN_HOST", "admin.ijary.app");

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      mocks.fetchCalls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return {
        ok: mocks.fetchStatus < 400,
        status: mocks.fetchStatus,
        statusText: "Bad Request",
        json: async () => mocks.fetchBody,
      } as unknown as Response;
    }),
  );
});

describe("the platform custom-domain operations (T192)", () => {
  it("refuses a caller without the platform admin claim before any database or provider call", async () => {
    mocks.isAdmin = false;

    await expect(platformListCompanyDomains(COMPANY_ID)).rejects.toThrow("PLATFORM_ADMIN_REQUIRED");
    await expect(
      platformAddCustomDomain({ companyId: COMPANY_ID, host: "www.acme.com" }),
    ).rejects.toThrow("PLATFORM_ADMIN_REQUIRED");
    await expect(
      platformVerifyCustomDomain({ domainId: "44444444-4444-4444-8444-444444444444" }),
    ).rejects.toThrow("PLATFORM_ADMIN_REQUIRED");

    expect(mocks.fetchCalls).toEqual([]);
    expect(mocks.domains).toEqual([]);
    expect(mocks.auditWrites).toEqual([]);
  });

  it("lists the domains of a company with the state the platform keeps for each", async () => {
    mocks.domains = [
      domainRow({ id: "1", host: "acme.ijary.app", kind: "subdomain" }),
      domainRow({
        id: "2",
        host: "www.acme.com",
        verification_status: "verified",
        verification_records: { txt: { name: "_cf", type: "txt", value: "v" } },
      }),
    ];

    const domains = await platformListCompanyDomains(COMPANY_ID);

    expect(domains.map((domain) => [domain.host, domain.verificationStatus])).toEqual([
      ["acme.ijary.app", "pending"],
      ["www.acme.com", "verified"],
    ]);
  });

  it.each([
    ["a host under the platform root domain", "acme.ijary.app"],
    ["the platform root host itself", "ijary.app"],
    ["the super admin host", "admin.ijary.app"],
  ])("refuses %s before calling the provider", async (_label, host) => {
    await expect(platformAddCustomDomain({ companyId: COMPANY_ID, host })).rejects.toThrow(
      "DOMAIN_RESERVED",
    );

    expect(mocks.fetchCalls).toEqual([]);
    expect(mocks.domains).toEqual([]);
  });

  it.each(["acme", "not a host", "www..acme.com"])(
    "refuses %s as a host name before calling the provider",
    async (host) => {
      await expect(platformAddCustomDomain({ companyId: COMPANY_ID, host })).rejects.toThrow(
        "DOMAIN_INVALID",
      );

      expect(mocks.fetchCalls).toEqual([]);
    },
  );

  it("refuses a host another domain already uses", async () => {
    mocks.domains = [domainRow({ host: "www.acme.com" })];

    await expect(
      platformAddCustomDomain({ companyId: COMPANY_ID, host: "www.acme.com" }),
    ).rejects.toThrow("DOMAIN_TAKEN");

    expect(mocks.fetchCalls).toEqual([]);
  });

  it("stores the hostname Cloudflare created as pending, with its ownership record", async () => {
    const domain = await platformAddCustomDomain({
      companyId: COMPANY_ID,
      host: "  WWW.Acme.COM. ",
    });

    expect(mocks.fetchCalls).toEqual([
      {
        url: "https://api.cloudflare.com/client/v4/zones/zone-123/custom_hostnames",
        method: "POST",
        body: { hostname: "www.acme.com", ssl: { method: "txt", type: "dv" } },
      },
    ]);
    expect(domain.host).toBe("www.acme.com");
    expect(domain.verificationStatus).toBe("pending");
    expect(domain.providerRef).toBe("cf-hostname-1");
    expect(domain.verificationRecords?.txt).toEqual({
      name: "_cf-custom-hostname.www.acme.com",
      type: "txt",
      value: "token-123",
    });

    const stored = mocks.domains[0];
    expect(stored).toMatchObject({
      company_id: COMPANY_ID,
      host: "www.acme.com",
      kind: "custom",
      verification_status: "pending",
      provider_ref: "cf-hostname-1",
    });
    expect(mocks.auditWrites).toHaveLength(1);
    expect(mocks.auditWrites[0]).toMatchObject({
      action: "company.domain.add",
      entity: "company_domain",
      company_id: COMPANY_ID,
      actor_id: ADMIN_ID,
    });
  });

  it("leaves no row and no audit entry when the provider refuses the hostname", async () => {
    cloudflareResponds(400, {
      success: false,
      errors: [{ message: "hostname is already attached to another zone" }],
    });

    await expect(
      platformAddCustomDomain({ companyId: COMPANY_ID, host: "www.acme.com" }),
    ).rejects.toThrow("hostname is already attached to another zone");

    expect(mocks.domains).toEqual([]);
    expect(mocks.auditWrites).toEqual([]);
  });

  it("marks the domain verified once the provider reports it active", async () => {
    mocks.domains = [domainRow()];
    cloudflareResponds(200, cloudflareResult({ status: "active", ssl: { status: "active" } }));

    const domain = await platformVerifyCustomDomain({
      domainId: "44444444-4444-4444-8444-444444444444",
    });

    expect(mocks.fetchCalls).toEqual([
      {
        url: "https://api.cloudflare.com/client/v4/zones/zone-123/custom_hostnames/cf-hostname-1",
        method: "GET",
        body: null,
      },
    ]);
    expect(domain.verificationStatus).toBe("verified");
    expect(mocks.auditWrites[0]).toMatchObject({
      action: "company.domain.verify",
      before: { verificationStatus: "pending" },
      after: { verificationStatus: "verified" },
    });
  });

  it("marks the domain failed when the provider reports a blocked hostname", async () => {
    mocks.domains = [domainRow()];
    cloudflareResponds(200, cloudflareResult({ status: "blocked" }));

    const domain = await platformVerifyCustomDomain({
      domainId: "44444444-4444-4444-8444-444444444444",
    });

    expect(domain.verificationStatus).toBe("failed");
  });

  it("keeps a pending hostname pending", async () => {
    mocks.domains = [domainRow()];
    cloudflareResponds(200, cloudflareResult({ status: "pending" }));

    const domain = await platformVerifyCustomDomain({
      domainId: "44444444-4444-4444-8444-444444444444",
    });

    expect(domain.verificationStatus).toBe("pending");
  });

  it("refuses to verify a domain that has no provider reference", async () => {
    mocks.domains = [domainRow({ provider_ref: null })];

    await expect(
      platformVerifyCustomDomain({ domainId: "44444444-4444-4444-8444-444444444444" }),
    ).rejects.toThrow("DOMAIN_NOT_CLOUDFLARE");

    expect(mocks.fetchCalls).toEqual([]);
  });
});
