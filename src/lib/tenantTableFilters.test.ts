import { describe, expect, test } from "vitest";

import {
  emptyTenantTableFilters,
  filterTenants,
  hasActiveTenantTableFilters,
  type TenantFilterRow,
  type TenantTableFilters,
} from "./tenantTableFilters";

function filters(overrides: Partial<TenantTableFilters> = {}): TenantTableFilters {
  return { ...emptyTenantTableFilters, ...overrides };
}

type Row = TenantFilterRow & { id: string };

function tenant(overrides: Partial<Row> = {}): Row {
  return {
    id: "t-1",
    category: "standard",
    lifecycle: "active",
    hasOverdue: false,
    connectedProperties: [],
    ...overrides,
  };
}

describe("hasActiveTenantTableFilters", () => {
  test("nothing set", () => {
    expect(hasActiveTenantTableFilters(emptyTenantTableFilters)).toBe(false);
  });

  test.each([
    ["propertyId", "p-1"],
    ["category", "vip"],
    ["lifecycle", "blocked"],
    ["arrears", "yes"],
  ])("%s alone counts as filtered", (key, value) => {
    expect(hasActiveTenantTableFilters(filters({ [key]: value }))).toBe(true);
  });
});

describe("filterTenants", () => {
  test("no filters lets every row through", () => {
    const rows = [tenant({ id: "a" }), tenant({ id: "b", category: "vip" })];
    expect(filterTenants(rows, emptyTenantTableFilters)).toEqual(rows);
  });

  test("a tenant renting in two buildings matches the second one", () => {
    // The primary building drives the sortable column; matching must not, or a
    // tenant with a shop in a second building disappears when you filter by it.
    const rows = [
      tenant({ id: "two-shops", connectedProperties: [{ id: "p-1" }, { id: "p-2" }] }),
      tenant({ id: "one-shop", connectedProperties: [{ id: "p-1" }] }),
    ];
    expect(filterTenants(rows, filters({ propertyId: "p-2" })).map((row) => row.id)).toEqual([
      "two-shops",
    ]);
  });

  test("a tenant with no active contract is excluded by any property filter", () => {
    const rows = [tenant({ id: "vacant", connectedProperties: [] })];
    expect(filterTenants(rows, filters({ propertyId: "p-1" }))).toEqual([]);
  });

  test.each([
    ["yes", ["overdue"]],
    ["no", ["clear"]],
    ["", ["overdue", "clear"]],
  ])("arrears=%s keeps %s", (arrears, expected) => {
    const rows = [
      tenant({ id: "overdue", hasOverdue: true }),
      tenant({ id: "clear", hasOverdue: false }),
    ];
    expect(filterTenants(rows, filters({ arrears })).map((row) => row.id)).toEqual(expected);
  });

  test("category and lifecycle narrow together, not separately", () => {
    // Each row satisfies one half of the pair; only the row matching both stays.
    const rows = [
      tenant({ id: "vip-active", category: "vip", lifecycle: "active" }),
      tenant({ id: "vip-blocked", category: "vip", lifecycle: "blocked" }),
      tenant({ id: "standard-blocked", category: "standard", lifecycle: "blocked" }),
    ];
    const kept = filterTenants(rows, filters({ category: "vip", lifecycle: "blocked" }));
    expect(kept.map((row) => row.id)).toEqual(["vip-blocked"]);
  });
});
