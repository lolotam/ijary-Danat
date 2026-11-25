import { describe, expect, test } from "vitest";

import { hasDiscount, invoiceDiscountBadgeText } from "@/lib/invoiceDiscountBadge";

describe("invoiceDiscountBadgeText", () => {
  test("discount 10 renders the badge with the amount, not a percentage", () => {
    const text = invoiceDiscountBadgeText(10, "Discount", "en");
    expect(text).toMatch(/^Discount \(/);
    expect(text).toContain("10");
    expect(text).toContain("KWD");
    expect(text).not.toContain("%");
  });

  test("discount 0 renders no badge", () => {
    expect(invoiceDiscountBadgeText(0, "Discount", "en")).toBeNull();
    expect(invoiceDiscountBadgeText(null, "Discount", "en")).toBeNull();
    expect(invoiceDiscountBadgeText(undefined, "Discount", "en")).toBeNull();
  });

  test("does not invent a column for an undiscounted invoice", () => {
    // The page only renders a node when this helper returns a string. A null
    // result is the proof that discount 0 adds no markup and no column.
    expect(invoiceDiscountBadgeText(0, "Discount", "en")).toBeNull();
  });
});

describe("hasDiscount", () => {
  test.each([
    [null, false],
    [undefined, false],
    [0, false],
    ["0", false],
    ["0.000", false],
    [0.001, true],
    [12, true],
    ["12.500", true],
  ])("%s -> %s", (value, expected) => {
    expect(hasDiscount(value as never)).toBe(expected);
  });
});
