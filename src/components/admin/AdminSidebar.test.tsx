import { describe, expect, test } from "vitest";

import { DEFAULT_MODULE_ENABLED, type ModuleKey } from "@/company/modules";
import {
  filterNavItems,
  PRIMARY_NAV_ITEMS,
  SECONDARY_NAV_ITEMS,
} from "@/components/admin/AdminSidebar";

describe("AdminSidebar module filtering (T111)", () => {
  test("hides disabled section links while keeping dashboard and settings", () => {
    const disabled = new Set<ModuleKey>(["electricity", "reports", "audit"]);
    const isEnabled = (key: ModuleKey) => DEFAULT_MODULE_ENABLED[key] && !disabled.has(key);

    const primaryKeys = filterNavItems(PRIMARY_NAV_ITEMS, isEnabled).map((item) => item.key);
    const secondaryKeys = filterNavItems(SECONDARY_NAV_ITEMS, isEnabled).map((item) => item.key);

    expect(primaryKeys).toContain("admin.dashboard");
    expect(primaryKeys).toContain("admin.invoices");
    expect(primaryKeys).not.toContain("admin.electricity");

    expect(secondaryKeys).toContain("admin.inbox");
    expect(secondaryKeys).toContain("admin.settings");
    expect(secondaryKeys).not.toContain("admin.reports");
    expect(secondaryKeys).not.toContain("admin.audit");
  });

  test("keeps always-on items even when all modules are disabled", () => {
    const noneEnabled = () => false;

    const primaryKeys = filterNavItems(PRIMARY_NAV_ITEMS, noneEnabled).map((item) => item.key);
    const secondaryKeys = filterNavItems(SECONDARY_NAV_ITEMS, noneEnabled).map((item) => item.key);

    expect(primaryKeys).toEqual(["admin.dashboard"]);
    expect(secondaryKeys).toEqual(["admin.settings"]);
  });
});
