import { describe, expect, test } from "vitest";

import { contractIncreaseEffectivePeriod, contractIncreaseLabel } from "@/lib/contractIncrease";

describe("contractIncreaseEffectivePeriod", () => {
  test("adds whole years and truncates to the month", () => {
    expect(contractIncreaseEffectivePeriod("2025-02-15", 2)).toBe("2027-02");
  });
});

describe("contractIncreaseLabel", () => {
  test("percent in Arabic and English", () => {
    expect(contractIncreaseLabel("ar", "percent", 10, "2027-02")).toBe("زيادة 10% من 2027-02");
    expect(contractIncreaseLabel("en", "percent", 10, "2027-02")).toBe("Increase 10% from 2027-02");
  });
  test("fixed shows KWD", () => {
    expect(contractIncreaseLabel("en", "fixed", 100, "2027-02")).toBe(
      "Increase 100 KWD from 2027-02",
    );
  });
});
