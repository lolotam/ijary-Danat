import { describe, expect, test } from "vitest";

import {
  concessionColumnsByContract,
  countActiveFreeMonths,
  formatFixedDiscountCell,
  formatPercentDiscountCell,
} from "@/lib/concessionColumns";

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
    expect(result.get("c1")).toEqual({
      freeMonths: 0,
      percentDiscount: null,
      fixedDiscount: { months: 3, amount: 100 },
    });
  });

  test("no discount yields null, not { months: 0 }", () => {
    const result = concessionColumnsByContract([]);
    expect(result.get("c1")).toBeUndefined();
    expect(formatPercentDiscountCell(null, "en")).toBeNull();
    expect(formatFixedDiscountCell(null, "en")).toBeNull();
    expect(countActiveFreeMonths([])).toBeNull();
  });

  test("a percentage concession renders months then the percent", () => {
    const result = concessionColumnsByContract([
      {
        contract_id: "c1",
        type: "percentage_discount",
        start_date: "2026-01-01",
        end_date: "2026-03-31",
        discount_percent: 30,
        discount_amount: null,
      },
    ]);
    expect(result.get("c1")?.percentDiscount).toEqual({ months: 3, percent: 30 });
    expect(formatPercentDiscountCell(result.get("c1")?.percentDiscount ?? null, "en")).toBe(
      "3 — 30%",
    );
  });

  test("free months count calendar months and stay off the discount columns", () => {
    const result = concessionColumnsByContract([
      {
        contract_id: "c1",
        type: "free_months",
        start_date: "2026-01-01",
        end_date: "2026-02-28",
        discount_percent: null,
        discount_amount: null,
      },
    ]);
    expect(result.get("c1")).toEqual({
      freeMonths: 2,
      percentDiscount: null,
      fixedDiscount: null,
    });
  });
});

describe("countActiveFreeMonths", () => {
  test("returns the month count for active free-month concessions", () => {
    expect(
      countActiveFreeMonths([
        {
          type: "free_months",
          status: "active",
          start_date: "2026-01-01",
          end_date: "2026-03-31",
        },
      ]),
    ).toBe(3);
  });

  test("returns null when there are no free months, not 0", () => {
    expect(
      countActiveFreeMonths([
        {
          type: "fixed_discount",
          status: "active",
          start_date: "2026-01-01",
          end_date: "2026-03-31",
        },
      ]),
    ).toBeNull();
    expect(countActiveFreeMonths([])).toBeNull();
  });

  test("ignores cancelled free-month records", () => {
    expect(
      countActiveFreeMonths([
        {
          type: "free_months",
          status: "cancelled",
          start_date: "2026-01-01",
          end_date: "2026-03-31",
        },
      ]),
    ).toBeNull();
  });
});
