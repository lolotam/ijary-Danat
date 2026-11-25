/**
 * Tenant portal tab visibility — one definition of the six tabs, and the rule
 * that decides which of them a given tenant sees.
 *
 * Two levels of control:
 *   1. The `tenant` role's permissions set the default for everyone.
 *   2. A per-tenant override on the tenant record can force a tab on or off.
 *
 * The override is deliberately nullable rather than a plain boolean, so the
 * three states stay distinct: `null` = follow the role default, `true` = always
 * show, `false` = always hide. A boolean could only ever express "force on",
 * which would leave no way to hide one tab from one tenant.
 *
 * This module is intentionally free of React and of icons so the rule can be
 * unit tested on its own; `routes/portal.tsx` maps tab keys to lucide icons.
 */

import type { PermissionCode } from "@/lib/permissions";

export type PortalTabKey =
  | "dashboard"
  | "lease"
  | "invoices"
  | "payments"
  | "receipts"
  | "profile"
  | "shop";

/** Tenant columns holding the per-tenant overrides (added in migration 46). */
export type PortalTabColumn =
  | "portal_tab_dashboard"
  | "portal_tab_lease"
  | "portal_tab_invoices"
  | "portal_tab_payments"
  | "portal_tab_profile"
  | "portal_tab_shop";

export interface PortalTab {
  key: PortalTabKey;
  /** Route path, matching the file-based routes in src/routes. */
  to: string;
  /** Dashboard lives at /portal itself, so it only matches exactly. */
  exact: boolean;
  labelKey: string;
  permission: PermissionCode;
  column: PortalTabColumn;
  /**
   * عند وجودها، يُخفى التبويب عن المستأجر الذي لا يملك متجراً مرتبطاً
   * حتى لو كان الدور يمنحه الصلاحية.
   *
   * Declared on the tab so visibility stays one pure function;
   * callers pass whether the tenant has a linked shop.
   */
  requiresLinkedShop?: boolean;
  /**
   * ملاحظة تُعرض تحت مفتاح التبويب في نموذج المستأجر.
   *
   * `requiresLinkedShop` is a second, invisible input to visibility: an admin
   * who leaves the shop tab on "use role default" sees nothing happen and has
   * no way to learn why. The rule is stated where the decision is made.
   */
  hintKey?: string;
}

/**
 * Order here is the order rendered in the portal nav, and the order used to
 * pick a fallback destination when a tenant lands on a hidden tab.
 */
export const PORTAL_TABS: readonly PortalTab[] = [
  {
    key: "dashboard",
    to: "/portal",
    exact: true,
    labelKey: "portal.nav.dashboard",
    permission: "portal.tab_dashboard",
    column: "portal_tab_dashboard",
  },
  {
    key: "lease",
    to: "/portal/lease",
    exact: false,
    labelKey: "portal.nav.lease",
    permission: "portal.tab_lease",
    column: "portal_tab_lease",
  },
  {
    key: "invoices",
    to: "/portal/invoices",
    exact: false,
    labelKey: "portal.nav.invoices",
    permission: "portal.tab_invoices",
    column: "portal_tab_invoices",
  },
  {
    key: "payments",
    to: "/portal/payments",
    exact: false,
    labelKey: "portal.nav.payments",
    permission: "portal.tab_payments",
    column: "portal_tab_payments",
  },
  {
    key: "shop",
    to: "/portal/shop",
    exact: false,
    labelKey: "portal.nav.shop",
    permission: "portal.tab_shop",
    column: "portal_tab_shop",
    requiresLinkedShop: true,
    hintKey: "tenants.portalTabs.shopHint",
  },
  {
    key: "profile",
    to: "/portal/profile",
    exact: false,
    labelKey: "portal.nav.profile",
    permission: "portal.tab_profile",
    column: "portal_tab_profile",
  },
];

/** The subset of a tenant row this module needs. */
export type PortalTabOverrides = Partial<Record<PortalTabColumn, boolean | null>>;

export interface PortalTabVisibilityOptions {
  hasLinkedShop?: boolean;
}

/**
 * Decide whether one tab is visible.
 *
 * @param rolePermissions Codes granted to the `tenant` role — NOT the viewing
 *   user's own permissions. An admin previewing a tenant portal must see what
 *   that tenant sees, and `usePermissions` short-circuits to true for admins.
 */
export function isPortalTabVisible(
  tab: PortalTab,
  overrides: PortalTabOverrides | null | undefined,
  rolePermissions: ReadonlySet<string>,
  options?: PortalTabVisibilityOptions,
): boolean {
  const override = overrides?.[tab.column];
  // Per-tenant override wins even for shop tabs.
  if (override === true || override === false) return override;

  // Shop tab needs a linked shop; hide while loading (undefined) or when false.
  if (tab.requiresLinkedShop && options?.hasLinkedShop !== true) return false;

  return rolePermissions.has(tab.permission);
}

/** The visible tabs, in nav order. */
export function visiblePortalTabs(
  overrides: PortalTabOverrides | null | undefined,
  rolePermissions: ReadonlySet<string>,
  options?: PortalTabVisibilityOptions,
): PortalTab[] {
  return PORTAL_TABS.filter((tab) => isPortalTabVisible(tab, overrides, rolePermissions, options));
}

/**
 * The tab a given pathname belongs to, or undefined for a path outside the
 * six tabs (the payment callback routes, for instance, which are never gated).
 *
 * Longest match wins so that `/portal/invoices` is not claimed by the exact
 * `/portal` dashboard entry.
 */
export function portalTabForPath(pathname: string): PortalTab | undefined {
  const path = pathname.replace(/\/+$/, "") || "/portal";
  return [...PORTAL_TABS]
    .sort((a, b) => b.to.length - a.to.length)
    .find((tab) =>
      tab.exact ? path === tab.to : path === tab.to || path.startsWith(`${tab.to}/`),
    );
}
