import { describe, expect, it } from "vitest";

import type { HostResolution, RequestCompany } from "@/company/requestCompany.server";
import { isRouteAllowedForHost } from "@/company/routeGating";

const ACME_COMPANY: RequestCompany = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "acme",
  status: "active",
  host: "acme.ijary.app",
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
    "/api/public/myfatoorah-webhook",
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
