import { describe, expect, test } from "vitest";

import { formatAmount, formatKwd, formatPercent, truncateAmount } from "@/lib/money";

describe("truncateAmount", () => {
  test("drops the fraction rather than rounding it", () => {
    expect(truncateAmount(100)).toBe(100);
    expect(truncateAmount(100.5)).toBe(100);
    expect(truncateAmount(25.999)).toBe(25);
  });

  test("truncates toward zero, so a credit loses its fraction the same way", () => {
    expect(truncateAmount(-25.999)).toBe(-25);
    expect(truncateAmount(-0.5)).toBe(0);
    // Not "-0": Intl renders the negative zero literally.
    expect(Object.is(truncateAmount(-0.5), -0)).toBe(false);
  });

  test("survives the float noise a numeric(14,3) column arrives with", () => {
    // A stored 26.000 can reach JavaScript as 25.999999999999996. Truncating
    // that naively would report 25 for an amount that is exactly 26.
    expect(truncateAmount(25.999999999999996)).toBe(26);
    expect(truncateAmount(99.99999999999999)).toBe(100);
  });

  test("the noise correction scales with magnitude", () => {
    // Representation error is proportional to the value: one unit in the last
    // place near the top of numeric(14,3) (~1e11) is already around 1.5e-5, so
    // a fixed 1e-9 nudge would report a whole-dinar total one dinar short.
    expect(truncateAmount(99999999999 - 1e-6)).toBe(99999999999);
    expect(truncateAmount(12345678901 - 1e-6)).toBe(12345678901);
    // …and still does not round a genuine fraction at that magnitude.
    expect(truncateAmount(99999999999.5)).toBe(99999999999);
  });

  test("absorbing that noise does not turn truncation into rounding", () => {
    // The guard against representation error must be far smaller than a fils.
    // Nudging by a whole rounding step would make every one of these round up.
    expect(truncateAmount(25.999)).toBe(25);
    expect(truncateAmount(25.9999)).toBe(25);
    expect(truncateAmount(25.999999)).toBe(25);
    expect(truncateAmount(-25.9999)).toBe(-25);
  });

  test("accepts the string form Postgres numerics are read back as", () => {
    expect(truncateAmount("1240.750")).toBe(1240);
  });

  test("treats absent and non-numeric input as zero", () => {
    expect(truncateAmount(null)).toBe(0);
    expect(truncateAmount(undefined)).toBe(0);
    expect(truncateAmount(Number.NaN)).toBe(0);
    expect(truncateAmount("not a number")).toBe(0);
    expect(truncateAmount(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("formatKwd", () => {
  test("renders a whole number with no decimal part", () => {
    expect(formatKwd(1240, "en")).toBe("1,240 KWD");
  });

  test("drops fils from a fractional amount", () => {
    expect(formatKwd(0.5, "en")).toBe("0 KWD");
    expect(formatKwd(1240.999, "en")).toBe("1,240 KWD");
  });

  test("uses Latin digits across all locales without reintroducing decimals", () => {
    expect(formatKwd(1240, "ar")).toBe("1,240 KWD");
    expect(formatKwd(1240, "en")).toBe("1,240 KWD");
  });
});

describe("formatAmount", () => {
  test("omits the currency for columns that carry it in the header and uses Latin digits", () => {
    expect(formatAmount(1240.75, "en")).toBe("1,240");
    expect(formatAmount(1240.75, "ar")).toBe("1,240");
    expect(formatAmount(null, "en")).toBe("0");
    expect(formatAmount(null, "ar")).toBe("0");
  });
});

describe("formatPercent", () => {
  test("renders a stored 10.00 as a whole percentage with Latin digits", () => {
    expect(formatPercent(10, "en")).toBe("10%");
    expect(formatPercent(10, "ar")).toBe("10%");
    expect(formatPercent(7.5, "en")).toBe("7%");
    expect(formatPercent(7.5, "ar")).toBe("7%");
  });
});
