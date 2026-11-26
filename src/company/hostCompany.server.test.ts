import { afterEach, describe, expect, it, vi } from "vitest";

import { CompanyContextError, isCompanyContextError } from "@/company/errors";
import {
  clearHostCompanyCache,
  extractRequestHost,
  extractSubdomainSlug,
  normalizeHost,
  resolveHostCompany,
} from "@/company/hostCompany.server";
import {
  getRequestCompany,
  getRequestHostResolution,
  requireRequestCompany,
  runWithRequestCompany,
  type RequestCompany,
} from "@/company/requestCompany.server";
import { withCompanyContext } from "../../server/middleware/company";

const ACME_COMPANY: RequestCompany = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "acme",
  status: "active",
  host: "acme.ijary.app",
};

/**
 * ينشئ دالة استعلام وهمية تتتبّع عدد مرات النداء وتُعيد شركة حسب المضيف.
 */
function createDomainFinder(byHost: Record<string, RequestCompany | null>) {
  return vi.fn(async (host: string) => byHost[host] ?? null);
}

describe("normalizeHost and extractRequestHost", () => {
  it("normalizes case, ports, proxy chains, and IPv6 hosts", () => {
    expect(normalizeHost("ACME.IJARY.APP:8443")).toBe("acme.ijary.app");
    expect(normalizeHost("acme.localhost:8080, proxy.internal")).toBe("acme.localhost");
    expect(normalizeHost("[::1]:8080")).toBe("[::1]");
    expect(normalizeHost("   ")).toBe("");
  });

  it("ignores a client-sent x-forwarded-host unless a trusted proxy sets it", () => {
    const req = new Request("http://internal:3000/admin", {
      headers: {
        "x-forwarded-host": "Acme.Ijary.App, proxy",
        host: "beta.ijary.app",
      },
    });
    expect(extractRequestHost(req, false)).toBe("beta.ijary.app");
    expect(extractRequestHost(req, true)).toBe("acme.ijary.app");
  });

  it("falls back to host header and request URL when x-forwarded-host is absent", () => {
    const withHost = new Request("http://internal:3000/portal", {
      headers: { host: "beta.localhost:8080" },
    });
    expect(extractRequestHost(withHost)).toBe("beta.localhost");

    const urlOnly = new Request("https://gamma.ijary.app/auth");
    expect(extractRequestHost(urlOnly)).toBe("gamma.ijary.app");
  });
});

describe("extractSubdomainSlug", () => {
  it.each([
    ["acme.ijary.app", "ijary.app", "acme"],
    ["danat-co1.localhost", "localhost", "danat-co1"],
    ["sub.acme.ijary.app", "ijary.app", null],
    ["a.ijary.app", "ijary.app", null],
    ["acme.ijary.app.evil.com", "ijary.app", null],
    ["acmeijary.app", "ijary.app", null],
  ])("%s under %s gives %s", (host, root, expected) => {
    expect(extractSubdomainSlug(host, root)).toBe(expected);
  });
});

describe("resolveHostCompany", () => {
  afterEach(() => {
    clearHostCompanyCache();
    vi.restoreAllMocks();
  });

  it("classifies platform root and admin hosts without querying the database", async () => {
    const findDomainCompany = createDomainFinder({});
    const deps = {
      rootHost: "ijary.app",
      adminHost: "admin.ijary.app",
      findDomainCompany,
    };

    expect(await resolveHostCompany("ijary.app", deps)).toEqual({
      kind: "platform_root",
      host: "ijary.app",
      company: null,
    });
    expect(await resolveHostCompany("ADMIN.IJARY.APP:443", deps)).toEqual({
      kind: "platform_admin",
      host: "admin.ijary.app",
      company: null,
    });
    expect(findDomainCompany).not.toHaveBeenCalled();
  });

  it("resolves verified company domains and caches them for 60 seconds", async () => {
    let clock = 1_000_000;
    const findDomainCompany = createDomainFinder({
      "acme.ijary.app": ACME_COMPANY,
    });
    const deps = {
      rootHost: "ijary.app",
      adminHost: "admin.ijary.app",
      findDomainCompany,
      now: () => clock,
    };

    const first = await resolveHostCompany("acme.ijary.app", deps);
    expect(first).toEqual({
      kind: "company",
      host: "acme.ijary.app",
      company: ACME_COMPANY,
    });
    expect(findDomainCompany).toHaveBeenCalledTimes(1);

    clock += 59_000;
    const cached = await resolveHostCompany("acme.ijary.app", deps);
    expect(cached).toEqual(first);
    expect(findDomainCompany).toHaveBeenCalledTimes(1);

    clock += 2_000;
    await resolveHostCompany("acme.ijary.app", deps);
    expect(findDomainCompany).toHaveBeenCalledTimes(2);
  });

  it("resolves <slug>.<root> by slug when no domain row exists, and only under the root host", async () => {
    const findCompanyBySlug = vi.fn(async (slug: string) =>
      slug === "acme" ? ACME_COMPANY : null,
    );
    const deps = {
      rootHost: "ijary.app",
      adminHost: "admin.ijary.app",
      findDomainCompany: createDomainFinder({}),
      findCompanyBySlug,
    };

    expect(await resolveHostCompany("acme.ijary.app", deps)).toEqual({
      kind: "company",
      host: "acme.ijary.app",
      company: ACME_COMPANY,
    });
    expect(findCompanyBySlug).toHaveBeenCalledWith("acme");

    expect(await resolveHostCompany("acme.localhost", deps)).toEqual({
      kind: "unknown",
      host: "acme.localhost",
      company: null,
    });
    expect(findCompanyBySlug).toHaveBeenCalledTimes(1);
  });

  it("does not cache transient lookup failures", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const findDomainCompany = vi
      .fn<() => Promise<RequestCompany | null>>()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(ACME_COMPANY);

    const deps = {
      rootHost: "ijary.app",
      adminHost: "admin.ijary.app",
      findDomainCompany,
    };

    const failed = await resolveHostCompany("acme.ijary.app", deps);
    expect(failed).toEqual({
      kind: "unknown",
      host: "acme.ijary.app",
      company: null,
    });

    const recovered = await resolveHostCompany("acme.ijary.app", deps);
    expect(recovered).toEqual({
      kind: "company",
      host: "acme.ijary.app",
      company: ACME_COMPANY,
    });
    expect(findDomainCompany).toHaveBeenCalledTimes(2);
  });
});

describe("requestCompany context and withCompanyContext middleware", () => {
  afterEach(() => {
    clearHostCompanyCache();
    vi.unstubAllEnvs();
  });

  it("returns null outside a request and throws COMPANY_REQUIRED from requireRequestCompany", () => {
    expect(getRequestCompany()).toBeNull();
    expect(getRequestHostResolution()).toBeNull();
    expect(() => requireRequestCompany()).toThrow(CompanyContextError);

    try {
      requireRequestCompany();
    } catch (error) {
      expect(isCompanyContextError(error, "COMPANY_REQUIRED")).toBe(true);
    }
  });

  it("isolates company context per async execution", async () => {
    const beta: RequestCompany = {
      id: "22222222-2222-4222-8222-222222222222",
      slug: "beta",
      status: "suspended",
      host: "beta.ijary.app",
    };

    const [a, b] = await Promise.all([
      runWithRequestCompany(ACME_COMPANY, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return requireRequestCompany();
      }),
      runWithRequestCompany(beta, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return requireRequestCompany();
      }),
    ]);

    expect(a).toEqual(ACME_COMPANY);
    expect(b).toEqual(beta);
    expect(getRequestCompany()).toBeNull();
  });

  it("throws COMPANY_REQUIRED when runWithRequestCompany is given null", () => {
    runWithRequestCompany(null, () => {
      expect(getRequestCompany()).toBeNull();
      expect(() => requireRequestCompany()).toThrow(CompanyContextError);
    });
  });

  it("wires host resolution into AsyncLocalStorage through withCompanyContext", async () => {
    vi.stubEnv("PLATFORM_ROOT_HOST", "ijary.app");
    vi.stubEnv("PLATFORM_ADMIN_HOST", "admin.ijary.app");

    const adminReq = new Request("https://admin.ijary.app/platform/companies");
    const adminRes = await withCompanyContext(adminReq, () => {
      expect(getRequestHostResolution()).toEqual({
        kind: "platform_admin",
        host: "admin.ijary.app",
        company: null,
      });
      expect(getRequestCompany()).toBeNull();
      return new Response("ok", { status: 200 });
    });

    expect(adminRes.status).toBe(200);
    expect(getRequestHostResolution()).toBeNull();

    const suspendedCompany: RequestCompany = {
      id: "33333333-3333-4333-8333-333333333333",
      slug: "frozen",
      status: "suspended",
      host: "frozen.ijary.app",
    };
    const companyReq = new Request("https://frozen.ijary.app/admin/invoices");
    const companyRes = await withCompanyContext(
      companyReq,
      () => {
        expect(requireRequestCompany()).toEqual(suspendedCompany);
        return new Response("company-ok", { status: 200 });
      },
      {
        rootHost: "ijary.app",
        adminHost: "admin.ijary.app",
        findDomainCompany: createDomainFinder({ "frozen.ijary.app": suspendedCompany }),
      },
    );

    expect(companyRes.status).toBe(200);
    expect(getRequestCompany()).toBeNull();
  });
});
