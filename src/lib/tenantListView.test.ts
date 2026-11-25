import { describe, expect, it, test } from "vitest";

import { effectiveTenantLifecycle, resolveTenantListView } from "./tenantListView";

/**
 * يثبّت مصفوفة التبويب ← معاملات الاستعلام التي تعتمد عليها تبويبات قائمة المستأجرين.
 *
 * The strict-equality check is the point: a stray `lifecycle: undefined` on
 * Archived/All would still be a key the hook forwards as a filter.
 */
describe("resolveTenantListView", () => {
  it.each([
    {
      view: "active" as const,
      expected: { archiveMode: "current", lifecycle: "active" },
    },
    {
      view: "ended" as const,
      expected: { archiveMode: "current", lifecycle: "contract_ended" },
    },
    {
      view: "archived" as const,
      expected: { archiveMode: "archived" },
    },
    {
      view: "all" as const,
      expected: { archiveMode: "all" },
    },
  ])("maps $view to the matching archive slice", ({ view, expected }) => {
    // toStrictEqual: `{ lifecycle: undefined }` must NOT pass for archived/all —
    // the hook would still see a lifecycle key.
    expect(resolveTenantListView(view)).toStrictEqual(expected);
  });
});

/**
 * اختيار المرشّح يغلب تثبيت التبويب: "منتهي العقد" على تبويب النشطين يجب أن يعيد صفوفاً.
 */
describe("effectiveTenantLifecycle", () => {
  test("the select wins over the tab when set", () => {
    expect(effectiveTenantLifecycle("active", "contract_ended")).toBe("contract_ended");
  });
  test("the tab applies when the select is empty", () => {
    expect(effectiveTenantLifecycle("active", "")).toBe("active");
    expect(effectiveTenantLifecycle("ended", "")).toBe("contract_ended");
  });
  test("all/archived tabs with an empty select send no lifecycle", () => {
    expect(effectiveTenantLifecycle("all", "")).toBeUndefined();
    expect(effectiveTenantLifecycle("archived", "")).toBeUndefined();
  });
});
