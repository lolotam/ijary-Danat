import { describe, expect, test } from "vitest";

import { concessionValueText } from "@/lib/concessionColumns";

/**
 * الإعفاء يجب أن يعرض قيمته، لا نوعه وتواريخه فقط.
 *
 * Regression test for the portal lease page (found 2026-09-03): it rendered
 * "Fixed discount · 01/10/2026 — 31/10/2026 · Active" and nothing else, so a
 * tenant with a 70 KWD discount could not see the 70. `free_months`,
 * `discount_percent` and `discount_amount` were all fetched and all discarded.
 */
describe("concessionValueText", () => {
  test("a fixed discount shows the amount as money", () => {
    expect(
      concessionValueText(
        {
          type: "fixed_discount",
          free_months: 0,
          discount_percent: null,
          discount_amount: 70,
        },
        "en",
        "months",
      ),
    ).toBe("70 KWD");
  });

  test("a percentage discount shows the percentage", () => {
    expect(
      concessionValueText(
        {
          type: "percentage_discount",
          free_months: 0,
          discount_percent: 15,
          discount_amount: null,
        },
        "en",
        "months",
      ),
    ).toBe("15%");
  });

  test("free months show the count with the caller's translated unit", () => {
    expect(
      concessionValueText(
        { type: "free_months", free_months: 3, discount_percent: null, discount_amount: null },
        "en",
        "months",
      ),
    ).toBe("3 months");
    expect(
      concessionValueText(
        { type: "free_months", free_months: 3, discount_percent: null, discount_amount: null },
        "ar",
        "شهر",
      ),
    ).toBe("3 شهر");
  });

  test.each([
    ["fixed discount with no amount", "fixed_discount" as const, null, null, 0],
    ["percentage discount with no percent", "percentage_discount" as const, null, null, 0],
    ["free months of zero", "free_months" as const, null, null, 0],
  ])("%s renders no value rather than a zero", (_label, type, percent, amount, months) => {
    expect(
      concessionValueText(
        {
          type,
          free_months: months,
          discount_percent: percent,
          discount_amount: amount,
        },
        "en",
        "months",
      ),
    ).toBeNull();
  });

  test("a zero fixed discount is a real value, not an absent one", () => {
    // 0 is stored, not null: the row exists and says the discount is nil. That
    // is different from a fixed_discount row with discount_amount null, which is
    // malformed. Rendering "0 KWD" is the honest read of the first.
    expect(
      concessionValueText(
        { type: "fixed_discount", free_months: 0, discount_percent: null, discount_amount: 0 },
        "en",
        "months",
      ),
    ).toBe("0 KWD");
  });
});
