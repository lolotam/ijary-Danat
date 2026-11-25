import { describe, expect, it } from "vitest";

import { invoicePeriodLabel } from "@/lib/invoicePeriodLabel";

describe("invoicePeriodLabel", () => {
  it("names every month in English", () => {
    const labels = Array.from({ length: 12 }, (_, index) => invoicePeriodLabel(2026, index + 1));
    expect(labels).toEqual([
      "January 2026",
      "February 2026",
      "March 2026",
      "April 2026",
      "May 2026",
      "June 2026",
      "July 2026",
      "August 2026",
      "September 2026",
      "October 2026",
      "November 2026",
      "December 2026",
    ]);
  });

  it("carries the year through unchanged", () => {
    expect(invoicePeriodLabel(2025, 12)).toBe("December 2025");
    expect(invoicePeriodLabel(2027, 1)).toBe("January 2027");
  });
});
