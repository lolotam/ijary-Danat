import { describe, expect, test } from "vitest";

import { summarizeContractLifecycles } from "@/lib/tenantLifecycleSummary";

describe("summarizeContractLifecycles", () => {
  test("counts contracts per state instead of repeating a badge each", () => {
    const summary = summarizeContractLifecycles([
      { state: "active", hasOverdue: false },
      { state: "active", hasOverdue: false },
    ]);

    expect(summary.states).toEqual([{ state: "active", count: 2 }]);
  });

  test("keeps every state the tenant holds, in the fixed display order", () => {
    // Fed in an order that is not the display order, so a passing test proves
    // the ordering is imposed rather than inherited from the input.
    const summary = summarizeContractLifecycles([
      { state: "terminated", hasOverdue: false },
      { state: "active", hasOverdue: false },
      { state: "expired", hasOverdue: false },
      { state: "active", hasOverdue: false },
    ]);

    expect(summary.states).toEqual([
      { state: "active", count: 2 },
      { state: "expired", count: 1 },
      { state: "terminated", count: 1 },
    ]);
  });

  test("counts overdue alongside state, not instead of it", () => {
    // A contract is `active` AND in arrears. Treating overdue as a state would
    // drop one of the two facts.
    const summary = summarizeContractLifecycles([
      { state: "active", hasOverdue: true },
      { state: "active", hasOverdue: false },
    ]);

    expect(summary.states).toEqual([{ state: "active", count: 2 }]);
    expect(summary.overdueCount).toBe(1);
  });

  test("counts contracts in arrears, not invoices", () => {
    const summary = summarizeContractLifecycles([
      { state: "active", hasOverdue: true },
      { state: "expired", hasOverdue: true },
    ]);

    expect(summary.overdueCount).toBe(2);
  });

  test("a tenant with no contracts summarises to nothing", () => {
    expect(summarizeContractLifecycles([])).toEqual({ states: [], overdueCount: 0 });
  });
});
