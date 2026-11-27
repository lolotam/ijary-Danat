import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearHostCompanyCache } from "@/company/hostCompany.server";
import { getRequestCompany, type RequestCompany } from "@/company/requestCompany.server";
import { withCompanyContext } from "../../server/middleware/company";

const SUSPENDED_COMPANY: RequestCompany = {
  id: "33333333-3333-4333-8333-333333333333",
  slug: "frozen",
  status: "suspended",
  host: "frozen.ijary.app",
};

const ACTIVE_COMPANY: RequestCompany = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "acme",
  status: "active",
  host: "acme.ijary.app",
};

/**
 * يشغّل وسيط سياق الشركة على طلب، مع مضيف شركة معلّقة أو نشطة، ويعيد الاستجابة وعدّاد النداء.
 */
async function runGated(request: Request, company: RequestCompany) {
  const next = vi.fn(async () => new Response("served", { status: 200 }));
  const response = await withCompanyContext(request, next, {
    rootHost: "ijary.app",
    adminHost: "admin.ijary.app",
    findDomainCompany: async (host) => (host === company.host ? company : null),
    findCompanyBySlug: async () => null,
  });
  return { response, next };
}

describe("the suspended company gate (T121)", () => {
  beforeEach(() => {
    clearHostCompanyCache();
  });

  afterEach(() => {
    clearHostCompanyCache();
    vi.restoreAllMocks();
  });

  it("answers a page request on a suspended company with the suspended page", async () => {
    const { response, next } = await runGated(
      new Request("https://frozen.ijary.app/admin/invoices"),
      SUSPENDED_COMPANY,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("حساب الشركة موقوف");
    // The application never runs: the request stops at the gate.
    expect(next).not.toHaveBeenCalled();
  });

  it("never caches the suspended page, so a reactivated company is not held paused", async () => {
    const { response } = await runGated(
      new Request("https://frozen.ijary.app/admin/invoices"),
      SUSPENDED_COMPANY,
    );

    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("reveals nothing about the company beyond the message", async () => {
    const { response } = await runGated(
      new Request("https://frozen.ijary.app/admin/invoices"),
      SUSPENDED_COMPANY,
    );
    const body = await response.text();

    expect(body).not.toContain(SUSPENDED_COMPANY.id);
    expect(body).not.toContain(SUSPENDED_COMPANY.slug);
    expect(body).not.toContain(SUSPENDED_COMPANY.host);
  });

  it.each([
    ["an api route", "https://frozen.ijary.app/api/oauth/google/callback"],
    ["a server function call", "https://frozen.ijary.app/_serverFn/createPayment"],
  ])("refuses %s on a suspended company with COMPANY_SUSPENDED", async (_label, url) => {
    const { response, next } = await runGated(
      new Request(url, { method: "POST", headers: { accept: "application/json" } }),
      SUSPENDED_COMPANY,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "COMPANY_SUSPENDED" });
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    ["the suspended page itself", "https://frozen.ijary.app/suspended"],
    ["a provider callback", "https://frozen.ijary.app/api/public/webhooks/myfatoorah/abc"],
    ["a static asset", "https://frozen.ijary.app/assets/app.css"],
  ])("lets %s through on a suspended company", async (_label, url) => {
    const { response, next } = await runGated(new Request(url), SUSPENDED_COMPANY);

    expect(response.status).toBe(200);
    expect(next).toHaveBeenCalledOnce();
  });

  it("leaves an active company untouched", async () => {
    const { response, next } = await runGated(
      new Request("https://acme.ijary.app/admin/invoices"),
      ACTIVE_COMPANY,
    );

    expect(response.status).toBe(200);
    expect(next).toHaveBeenCalledOnce();
  });

  it("serves the suspended page itself without a company context", async () => {
    // A suspended company cannot read its own data, so the root loader's
    // branding read would throw and the page would never render. The page
    // names no company, so it is served without one.
    let companyInsideHandler: RequestCompany | null | undefined;
    const next = vi.fn(async () => {
      companyInsideHandler = getRequestCompany();
      return new Response("served", { status: 200 });
    });

    await withCompanyContext(new Request("https://frozen.ijary.app/suspended"), next, {
      rootHost: "ijary.app",
      adminHost: "admin.ijary.app",
      findDomainCompany: async (host) =>
        host === SUSPENDED_COMPANY.host ? SUSPENDED_COMPANY : null,
      findCompanyBySlug: async () => null,
    });

    expect(next).toHaveBeenCalledOnce();
    expect(companyInsideHandler).toBeNull();
  });
});
