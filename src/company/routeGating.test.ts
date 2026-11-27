import { describe, expect, it } from "vitest";

import type { HostResolution, RequestCompany } from "@/company/requestCompany.server";
import { isRouteAllowedForHost, suspendedRouteDecision } from "@/company/routeGating";

const ACME_COMPANY: RequestCompany = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "acme",
  status: "active",
  host: "acme.ijary.app",
};

const SUSPENDED_COMPANY: RequestCompany = {
  id: "33333333-3333-4333-8333-333333333333",
  slug: "frozen",
  status: "suspended",
  host: "frozen.ijary.app",
};

const COMPANY_RESOLUTION: HostResolution = {
  kind: "company",
  host: "acme.ijary.app",
  company: ACME_COMPANY,
};
const ROOT_RESOLUTION: HostResolution = { kind: "platform_root", host: "ijary.app", company: null };
const ADMIN_RESOLUTION: HostResolution = {
  kind: "platform_admin",
  host: "admin.ijary.app",
  company: null,
};
const UNKNOWN_RESOLUTION: HostResolution = {
  kind: "unknown",
  host: "ghost.ijary.app",
  company: null,
};
const SUSPENDED_RESOLUTION: HostResolution = {
  kind: "company",
  host: "frozen.ijary.app",
  company: SUSPENDED_COMPANY,
};

describe("isRouteAllowedForHost", () => {
  it.each(["/platform", "/platform/"])(
    "panel path %s at the segment boundary is served on the admin host",
    (pathname) => {
      expect(isRouteAllowedForHost(ADMIN_RESOLUTION, pathname)).toBe(true);
    },
  );

  it.each(["/platform", "/platform/"])(
    "panel path %s at the segment boundary is refused off the admin host",
    (pathname) => {
      expect(isRouteAllowedForHost(ROOT_RESOLUTION, pathname)).toBe(false);
      expect(isRouteAllowedForHost(COMPANY_RESOLUTION, pathname)).toBe(false);
    },
  );

  // The router matches case-insensitively and decodes the path, so each of
  // these spellings would render the panel if the gate compared raw text.
  it.each(["/PLATFORM/companies", "/Platform", "/%70latform/companies", "//platform", "/%E0%A4%A"])(
    "panel spelling %s is refused on a company host",
    (pathname) => {
      expect(isRouteAllowedForHost(COMPANY_RESOLUTION, pathname)).toBe(false);
    },
  );

  it.each(["/ADMIN/invoices", "/%61dmin", "//portal/home"])(
    "company app spelling %s is refused on the admin host",
    (pathname) => {
      expect(isRouteAllowedForHost(ADMIN_RESOLUTION, pathname)).toBe(false);
    },
  );

  // A support-session link carries a staff token; it must only open on the
  // company host the token was minted for, never on the platform hosts.
  it("support-session entry is a company-host page only", () => {
    expect(isRouteAllowedForHost(COMPANY_RESOLUTION, "/support-session")).toBe(true);
    expect(isRouteAllowedForHost(ADMIN_RESOLUTION, "/support-session")).toBe(false);
    expect(isRouteAllowedForHost(ROOT_RESOLUTION, "/Support-Session")).toBe(false);
  });

  it.each(["/platformx", "/platform-old"])(
    "look-alike %s is not gated as the panel on a company host",
    (pathname) => {
      expect(isRouteAllowedForHost(COMPANY_RESOLUTION, pathname)).toBe(true);
    },
  );

  it.each(["/administration", "/admin-old", "/portal-x", "/portals"])(
    "look-alike %s is not gated as a company app path on the admin host",
    (pathname) => {
      expect(isRouteAllowedForHost(ADMIN_RESOLUTION, pathname)).toBe(true);
    },
  );

  it.each([
    "/api/public",
    "/api/public/webhooks/myfatoorah/00000000-0000-4000-8000-000000000001",
    "/api/public/resend-webhook",
    "/api/public/evolution-webhook",
  ])("public webhook %s stays reachable on an unknown host", (pathname) => {
    expect(isRouteAllowedForHost(UNKNOWN_RESOLUTION, pathname)).toBe(true);
  });

  it.each(["/", "/auth", "/terms", "/api/oauth/google/callback", "/assets/app.css"])(
    "unknown host is refused for %s outside the webhooks",
    (pathname) => {
      expect(isRouteAllowedForHost(UNKNOWN_RESOLUTION, pathname)).toBe(false);
    },
  );

  it.each(["/", "/auth", "/terms"])(
    "unguarded path %s is served on the platform root",
    (pathname) => {
      expect(isRouteAllowedForHost(ROOT_RESOLUTION, pathname)).toBe(true);
    },
  );

  it.each(["/", "/auth", "/terms"])("unguarded path %s is served on a company host", (pathname) => {
    expect(isRouteAllowedForHost(COMPANY_RESOLUTION, pathname)).toBe(true);
  });

  it.each(["/", "/auth", "/terms"])("unguarded path %s is served on the admin host", (pathname) => {
    expect(isRouteAllowedForHost(ADMIN_RESOLUTION, pathname)).toBe(true);
  });
});

describe("suspendedRouteDecision", () => {
  /**
   * يبني طلب صفحة كيرسله المتصفّح: يقبل HTML.
   */
  function documentRequest(pathname: string): Request {
    return new Request(`https://frozen.ijary.app${pathname}`, {
      headers: { accept: "text/html" },
    });
  }

  it.each([
    ["the suspended page itself", "/suspended", "allowed"],
    ["a provider callback", "/api/public/webhooks/myfatoorah/abc", "allowed"],
    ["a static asset", "/assets/app.css", "allowed"],
    ["an application page", "/admin/invoices", "page"],
    ["the tenant portal", "/portal/invoices", "page"],
    ["an api route", "/api/oauth/google/callback", "forbidden"],
    ["a server function call", "/_serverFn/createPayment", "forbidden"],
  ])("answers %s on a suspended company with %s", (_label, pathname, expected) => {
    expect(suspendedRouteDecision(documentRequest(pathname), SUSPENDED_RESOLUTION, pathname)).toBe(
      expected,
    );
  });

  it("reads a request that does not accept HTML as an api call", () => {
    const request = new Request("https://frozen.ijary.app/admin/invoices", {
      headers: { accept: "application/json" },
    });

    expect(suspendedRouteDecision(request, SUSPENDED_RESOLUTION, "/admin/invoices")).toBe(
      "forbidden",
    );
  });

  it.each([
    ["an active company", COMPANY_RESOLUTION],
    ["the platform root", ROOT_RESOLUTION],
    ["the super admin host", ADMIN_RESOLUTION],
    ["an unknown host", UNKNOWN_RESOLUTION],
  ])("leaves %s alone", (_label, resolution) => {
    expect(
      suspendedRouteDecision(documentRequest("/admin/invoices"), resolution, "/admin/invoices"),
    ).toBe("allowed");
  });
});
