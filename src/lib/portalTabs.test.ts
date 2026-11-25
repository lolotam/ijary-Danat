import { describe, expect, it } from "vitest";

import { PERMISSION_CODES } from "./permissions";
import { permissionLabel } from "./permissionLabels";
import {
  PORTAL_TABS,
  isPortalTabVisible,
  portalTabForPath,
  visiblePortalTabs,
  type PortalTabOverrides,
} from "./portalTabs";

const tab = (key: string) => PORTAL_TABS.find((entry) => entry.key === key)!;

/** Every tab granted to the `tenant` role. Migration 46 seeded six; the
 *  receipts tab was removed in migration 63 as a duplicate of My Payments. */
const ALL_GRANTED = new Set(PORTAL_TABS.map((entry) => entry.permission as string));
const NONE_GRANTED = new Set<string>();

describe("portalTabs — stays in sync with the permission catalog", () => {
  it("registers every tab permission in PERMISSION_CODES", () => {
    // A tab whose code is missing here would be invisible in the roles pool and
    // impossible to grant, so the tab could never be turned on globally.
    for (const tab of PORTAL_TABS) {
      expect(PERMISSION_CODES).toContain(tab.permission);
    }
  });

  it("keeps the codes under the portal module so the roles screen groups them", () => {
    // admin.settings.roles.tsx groups by code.split(".")[0] and the built-in
    // matrix filters by startsWith("portal."). Both rely on this prefix.
    for (const tab of PORTAL_TABS) {
      expect(tab.permission.startsWith("portal.")).toBe(true);
    }
  });

  it("gives every tab permission a readable label in both locales", () => {
    // Without a specialLabels entry the fallback renders the raw action, e.g.
    // "Tenant portal: tab_dashboard".
    for (const tab of PORTAL_TABS) {
      for (const locale of ["ar", "en"] as const) {
        expect(permissionLabel(tab.permission, locale)).not.toMatch(/tab_/);
      }
    }
  });

  it("maps each tab to a distinct column and route", () => {
    expect(new Set(PORTAL_TABS.map((tab) => tab.column)).size).toBe(PORTAL_TABS.length);
    expect(new Set(PORTAL_TABS.map((tab) => tab.to)).size).toBe(PORTAL_TABS.length);
  });
});

describe("portalTabs — role default with no per-tenant override", () => {
  const noOverrides: PortalTabOverrides = {};

  it("shows a tab the tenant role is granted", () => {
    expect(isPortalTabVisible(tab("invoices"), noOverrides, ALL_GRANTED)).toBe(true);
  });

  it("hides a tab the tenant role is not granted", () => {
    expect(isPortalTabVisible(tab("invoices"), noOverrides, NONE_GRANTED)).toBe(false);
  });

  it("treats a null override as 'follow the role', not as 'hide'", () => {
    // The whole point of the column being nullable: null must be distinct from
    // false, or every existing tenant row would hide every tab.
    const inherit: PortalTabOverrides = { portal_tab_invoices: null };

    expect(isPortalTabVisible(tab("invoices"), inherit, ALL_GRANTED)).toBe(true);
    expect(isPortalTabVisible(tab("invoices"), inherit, NONE_GRANTED)).toBe(false);
  });

  it("treats a missing tenant record as pure role default", () => {
    expect(isPortalTabVisible(tab("lease"), null, ALL_GRANTED)).toBe(true);
    expect(isPortalTabVisible(tab("lease"), undefined, NONE_GRANTED)).toBe(false);
  });
});

describe("portalTabs — per-tenant override beats the role default", () => {
  it("shows a globally disabled tab when forced on for this tenant", () => {
    // The case the feature was asked for.
    const forceOn: PortalTabOverrides = { portal_tab_invoices: true };

    expect(isPortalTabVisible(tab("invoices"), forceOn, NONE_GRANTED)).toBe(true);
  });

  it("hides a globally enabled tab when forced off for this tenant", () => {
    const forceOff: PortalTabOverrides = { portal_tab_payments: false };

    expect(isPortalTabVisible(tab("payments"), forceOff, ALL_GRANTED)).toBe(false);
  });

  it("applies an override only to its own tab", () => {
    const forceOff: PortalTabOverrides = { portal_tab_payments: false };

    expect(isPortalTabVisible(tab("invoices"), forceOff, ALL_GRANTED)).toBe(true);
  });
});

describe("portalTabs — visible set", () => {
  it("returns every tab in nav order when everything is granted", () => {
    expect(visiblePortalTabs({}, ALL_GRANTED).map((entry) => entry.key)).toEqual([
      "dashboard",
      "lease",
      "invoices",
      "payments",
      "profile",
    ]);
  });

  it("returns an empty set when the role grants nothing and nothing is forced on", () => {
    // portal.tsx must render its own empty state for this rather than
    // redirecting, or a tenant would bounce between hidden routes forever.
    expect(visiblePortalTabs({}, NONE_GRANTED)).toEqual([]);
  });

  it("keeps nav order when overrides reinstate a tab", () => {
    const forceOn: PortalTabOverrides = { portal_tab_profile: true };

    expect(visiblePortalTabs(forceOn, NONE_GRANTED).map((entry) => entry.key)).toEqual(["profile"]);
  });
});

describe("portalTabs — payments tab with the role grant revoked", () => {
  const rolesWithoutPayments = new Set(
    PORTAL_TABS.filter((entry) => entry.permission !== "portal.tab_payments").map(
      (entry) => entry.permission as string,
    ),
  );

  it.each([
    ["inherits", null, false],
    ["is forced on", true, true],
    ["is forced off", false, false],
  ] as const)(
    "the payments tab with the role grant gone: tenant %s -> %s",
    (_case, override, expected) => {
      expect(
        isPortalTabVisible(
          tab("payments"),
          { portal_tab_payments: override },
          rolesWithoutPayments,
        ),
      ).toBe(expected);
    },
  );
});

describe("portalTabs — path matching", () => {
  it("matches the dashboard only exactly", () => {
    expect(portalTabForPath("/portal")?.key).toBe("dashboard");
  });

  it("does not let the dashboard swallow a nested tab", () => {
    expect(portalTabForPath("/portal/invoices")?.key).toBe("invoices");
  });

  it("matches nested paths under a tab", () => {
    expect(portalTabForPath("/portal/payments/history")?.key).toBe("payments");
  });

  it("tolerates a trailing slash", () => {
    expect(portalTabForPath("/portal/")?.key).toBe("dashboard");
    expect(portalTabForPath("/portal/lease/")?.key).toBe("lease");
  });

  it("returns undefined for routes outside the portal tabs", () => {
    // e.g. the MyFatoorah callback routes, which must never be gated.
    expect(portalTabForPath("/portal/payments-callback")).toBeUndefined();
    expect(portalTabForPath("/admin/tenants")).toBeUndefined();
  });
});
