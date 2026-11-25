import { describe, expect, test } from "vitest";

import { concessionMonthsByContract, shouldNotifyContractEnded } from "@/hooks/useContracts";
import { concessionColumnsByContract } from "@/lib/concessionColumns";

describe("concessionMonthsByContract", () => {
  test.each([
    {
      name: "mid-month start and end span whole calendar months",
      start: "2026-01-15",
      end: "2026-03-10",
      expected: 3,
    },
    {
      name: "start and end within one month count once",
      start: "2026-05-01",
      end: "2026-05-31",
      expected: 1,
    },
    {
      name: "range crossing a year boundary keeps counting",
      start: "2025-11-10",
      end: "2026-01-05",
      expected: 3,
    },
  ])("a single concession where $name → $expected months", ({ start, end, expected }) => {
    const result = concessionMonthsByContract([
      { contract_id: "c1", start_date: start, end_date: end },
    ]);
    expect(result.get("c1")).toBe(expected);
  });

  test("unions overlapping concessions instead of summing them", () => {
    const result = concessionMonthsByContract([
      { contract_id: "c1", start_date: "2026-01-01", end_date: "2026-02-28" }, // Jan, Feb
      { contract_id: "c1", start_date: "2026-02-01", end_date: "2026-03-31" }, // Feb, Mar
    ]);
    // Distinct months: Jan, Feb, Mar → 3 (not 4).
    expect(result.get("c1")).toBe(3);
  });

  test("keeps contracts separate and omits those with no concessions", () => {
    const result = concessionMonthsByContract([
      { contract_id: "c1", start_date: "2026-01-01", end_date: "2026-01-31" },
    ]);
    expect(result.get("c1")).toBe(1);
    expect(result.get("c2")).toBeUndefined();
  });
});

describe("concessionColumnsByContract", () => {
  test("a 3-month fixed discount of 100 yields months 3 and amount 100", () => {
    const result = concessionColumnsByContract([
      {
        contract_id: "c1",
        type: "fixed_discount",
        start_date: "2026-01-01",
        end_date: "2026-03-31",
        discount_percent: null,
        discount_amount: 100,
      },
    ]);
    expect(result.get("c1")?.fixedDiscount).toEqual({ months: 3, amount: 100 });
  });

  test("no discount yields null for both, not { months: 0 }", () => {
    const result = concessionColumnsByContract([]);
    expect(result.get("c1")).toBeUndefined();
    expect(concessionColumnsByContract([])).toEqual(new Map());
  });
});

describe("shouldNotifyContractEnded", () => {
  test.each([
    { previous: "active", next: "expired", expected: true },
    { previous: "draft", next: "terminated", expected: true },
    { previous: "suspended", next: "renewed", expected: true },
    { previous: "expired", next: "terminated", expected: false },
    { previous: "active", next: "suspended", expected: false },
  ] as const)("returns $expected for $previous to $next", ({ previous, next, expected }) => {
    expect(shouldNotifyContractEnded(previous, next)).toBe(expected);
  });
});
