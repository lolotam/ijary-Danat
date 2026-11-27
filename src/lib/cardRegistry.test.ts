import { describe, expect, test } from "vitest";

import { DEFAULT_MODULE_ENABLED, type ModuleKey } from "@/company/modules";
import { CARD_REGISTRY, cardsByPage, isCardModuleEnabled } from "@/lib/cardRegistry";

describe("cardRegistry module filtering (T111)", () => {
  test("hides cards belonging to disabled sections on dashboard and section pages", () => {
    const disabled = new Set<ModuleKey>(["employees", "deposits"]);
    const isEnabled = (key: ModuleKey) => DEFAULT_MODULE_ENABLED[key] && !disabled.has(key);

    const groups = cardsByPage(isEnabled);
    const dashboardGroup = groups.find((g) => g.page === "dashboard");
    const depositsGroup = groups.find((g) => g.page === "deposits");

    expect(dashboardGroup?.cards.map((c) => c.id)).not.toContain("dashboard.employees");
    expect(dashboardGroup?.cards.map((c) => c.id)).not.toContain("dashboard.salaries");
    expect(dashboardGroup?.cards.map((c) => c.id)).toContain("dashboard.outstanding");
    expect(depositsGroup).toBeUndefined();
  });

  test("keeps portal cards visible even when all admin sections are disabled", () => {
    const groups = cardsByPage(() => false);

    expect(groups.map((g) => g.page)).toEqual(["portal"]);
    expect(groups[0].cards.length).toBeGreaterThan(0);
  });

  test("isCardModuleEnabled checks card.module when present", () => {
    const employeesCard = CARD_REGISTRY.find((c) => c.id === "dashboard.employees")!;
    const portalCard = CARD_REGISTRY.find((c) => c.id === "portal.nextDue")!;

    expect(isCardModuleEnabled(employeesCard, () => false)).toBe(false);
    expect(isCardModuleEnabled(employeesCard, () => true)).toBe(true);
    expect(isCardModuleEnabled(portalCard, () => false)).toBe(true);
  });
});
