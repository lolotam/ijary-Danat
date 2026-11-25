import { describe, expect, test } from "vitest";

import {
  contractTenantOptions,
  emptyContractTableFilters,
  filterContracts,
  hasActiveContractTableFilters,
  type ContractFilterRow,
  type ContractTableFilters,
} from "./contractTableFilters";

function filters(overrides: Partial<ContractTableFilters> = {}): ContractTableFilters {
  return { ...emptyContractTableFilters, ...overrides };
}

type Row = ContractFilterRow & { id: string };

function contract(overrides: Partial<Row> = {}): Row {
  return {
    id: "c-1",
    tenant_id: "t-1",
    end_date: "2026-12-31",
    units: [],
    hasOverdue: false,
    ...overrides,
  };
}

describe("hasActiveContractTableFilters", () => {
  test("nothing set", () => {
    expect(hasActiveContractTableFilters(emptyContractTableFilters)).toBe(false);
  });

  test.each([
    ["propertyId", "p-1"],
    ["tenantId", "t-9"],
    ["expiryFrom", "2026-01-01"],
    ["expiryTo", "2026-12-31"],
    ["arrears", "yes"],
  ])("%s alone counts as filtered", (key, value) => {
    expect(hasActiveContractTableFilters(filters({ [key]: value }))).toBe(true);
  });
});

describe("filterContracts", () => {
  test("no filters lets every row through", () => {
    const rows = [contract({ id: "a" }), contract({ id: "b", tenant_id: "t-2" })];
    expect(filterContracts(rows, emptyContractTableFilters)).toEqual(rows);
  });

  test("a contract spanning two buildings matches the second one", () => {
    // Matching walks every unit, not primaryUnit — a two-building contract is a
    // contract of both, and filtering by the second must still find it.
    const rows = [
      contract({
        id: "two-buildings",
        units: [{ property: { id: "p-1" } }, { property: { id: "p-2" } }],
      }),
      contract({ id: "one-building", units: [{ property: { id: "p-1" } }] }),
    ];
    expect(filterContracts(rows, filters({ propertyId: "p-2" })).map((row) => row.id)).toEqual([
      "two-buildings",
    ]);
  });

  test("a unit whose property failed to load does not match any building", () => {
    // `property` is nullable on ContractUnitDetail; a null must not be treated
    // as a wildcard that leaks the row into every property's results.
    const rows = [contract({ id: "orphan", units: [{ property: null }] })];
    expect(filterContracts(rows, filters({ propertyId: "p-1" }))).toEqual([]);
  });

  test("the expiry range is inclusive on both ends", () => {
    const rows = [
      contract({ id: "before", end_date: "2026-05-31" }),
      contract({ id: "on-from", end_date: "2026-06-01" }),
      contract({ id: "on-to", end_date: "2026-06-30" }),
      contract({ id: "after", end_date: "2026-07-01" }),
    ];
    const kept = filterContracts(
      rows,
      filters({ expiryFrom: "2026-06-01", expiryTo: "2026-06-30" }),
    );
    expect(kept.map((row) => row.id)).toEqual(["on-from", "on-to"]);
  });

  test("one bound alone leaves the other side open", () => {
    const rows = [
      contract({ id: "old", end_date: "2025-01-01" }),
      contract({ id: "far", end_date: "2030-01-01" }),
    ];
    expect(
      filterContracts(rows, filters({ expiryFrom: "2026-01-01" })).map((row) => row.id),
    ).toEqual(["far"]);
  });

  // All three arrears settings against the same pair, because each one alone
  // is satisfiable by a wrong predicate: `!== "no"` passes the "yes" row, a
  // dropped branch passes the "no" row, and an unguarded predicate passes
  // neither only when "" is asked for. Together they pin the tri-state.
  test.each([
    ["yes", ["owing"]],
    ["no", ["clear"]],
    ["", ["owing", "clear"]],
  ])("arrears %j selects the contracts wearing that badge", (arrears, expected) => {
    const rows = [
      contract({ id: "owing", hasOverdue: true }),
      contract({ id: "clear", hasOverdue: false }),
    ];
    expect(filterContracts(rows, filters({ arrears })).map((row) => row.id)).toEqual(expected);
  });

  test("arrears composes with the other filters rather than replacing them", () => {
    // Each predicate returns early, so a filter accidentally written as the
    // last `return` of the chain would silently discard the ones before it.
    const rows = [
      contract({ id: "match", tenant_id: "t-9", hasOverdue: true }),
      contract({ id: "wrong-tenant", tenant_id: "t-1", hasOverdue: true }),
      contract({ id: "not-owing", tenant_id: "t-9", hasOverdue: false }),
    ];
    expect(
      filterContracts(rows, filters({ tenantId: "t-9", arrears: "yes" })).map((row) => row.id),
    ).toEqual(["match"]);
  });

  test("dates spanning a year boundary compare chronologically", () => {
    // String comparison is only chronological because these are ISO dates; a
    // 2029→2030 pair catches a comparator that fell back to numbers or locale.
    const rows = [
      contract({ id: "dec", end_date: "2029-12-31" }),
      contract({ id: "jan", end_date: "2030-01-01" }),
    ];
    expect(
      filterContracts(rows, filters({ expiryFrom: "2030-01-01" })).map((row) => row.id),
    ).toEqual(["jan"]);
  });
});

describe("contractTenantOptions", () => {
  const labelOf = (row: { label: string | null }) => row.label;

  test("a tenant holding several contracts appears once", () => {
    const rows = [
      { tenant_id: "t-1", label: "Acme" },
      { tenant_id: "t-1", label: "Acme" },
      { tenant_id: "t-2", label: "Beta" },
    ];
    expect(contractTenantOptions(rows, labelOf)).toEqual([
      { value: "t-1", label: "Acme" },
      { value: "t-2", label: "Beta" },
    ]);
  });

  test("options are ordered by label, not by the order contracts arrived", () => {
    const rows = [
      { tenant_id: "t-1", label: "Zahra" },
      { tenant_id: "t-2", label: "Ahmad" },
    ];
    expect(contractTenantOptions(rows, labelOf).map((option) => option.label)).toEqual([
      "Ahmad",
      "Zahra",
    ]);
  });

  test("a contract whose tenant failed to load is left out", () => {
    // `contract.tenant` is nullable while the tenants query is in flight; an
    // unlabelled option would render as an empty row that filters to nothing.
    const rows = [
      { tenant_id: "t-1", label: null },
      { tenant_id: "t-2", label: "Beta" },
    ];
    expect(contractTenantOptions(rows, labelOf)).toEqual([{ value: "t-2", label: "Beta" }]);
  });
});
