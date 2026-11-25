import { describe, expect, it } from "vitest";

import { resolvePortalContractId, withContractSearch } from "@/hooks/usePortalContractSelection";

describe("withContractSearch", () => {
  it("sets the contract id from the selection", () => {
    expect(withContractSearch({}, "c1")).toEqual({ contract: "c1" });
  });

  it("preserves ?tenant= when changing contract", () => {
    // Dropping ?tenant makes the portal layout treat a previewing admin as plain
    // staff and bounce them to /admin — the bug portal.index.tsx already guards.
    expect(withContractSearch({ tenant: "t1" }, "c2")).toEqual({
      tenant: "t1",
      contract: "c2",
    });
  });
});

describe("resolvePortalContractId", () => {
  const available = ["c1", "c2"];

  it("keeps an id the tenant actually holds", () => {
    expect(resolvePortalContractId("c1", available, true)).toBe("c1");
  });

  it("selects the most recent contract when the url says nothing", () => {
    // usePortalContracts orders by start_date descending, so available[0] is the
    // tenant's newest lease — the one they are most likely asking about.
    expect(resolvePortalContractId(null, available, true)).toBe("c1");
  });

  it.each([
    ["a foreign contract id", "someone-elses"],
    ["a malformed value that would fail the uuid cast", "not-a-uuid"],
    ["an archived contract usePortalContracts never lists", "archived-c9"],
  ])("falls back to the first contract rather than passing through %s", (_case, raw) => {
    // Migration 121 raises on a contract belonging to another tenant, and a
    // malformed value errors on the cast. Neither is useful to show a tenant.
    expect(resolvePortalContractId(raw, available, true)).toBe("c1");
  });

  it("resolves to null when the tenant has no contracts at all", () => {
    // Not the same as "still loading": a tenant whose only contract has been
    // archived lists nothing here but can still hold unpaid invoices. Null keeps
    // p_contract_id unset so those invoices stay visible and payable.
    expect(resolvePortalContractId(null, [], true)).toBeNull();
    expect(resolvePortalContractId("c1", [], true)).toBeNull();
  });

  it("holds the raw value while the contract list is still loading", () => {
    // Resolving here would flip the selection to the first contract on every
    // refresh before the query returns, which reads as the filter resetting.
    expect(resolvePortalContractId("c1", [], false)).toBe("c1");
  });
});
