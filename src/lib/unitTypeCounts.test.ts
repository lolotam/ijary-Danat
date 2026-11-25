import { describe, expect, test } from "vitest";

import { countUnitsByType } from "./unitTypeCounts";

const sample = [
  { type: "shop" },
  { type: "shop" },
  { type: "commercial" },
  { type: "apartment" },
  { type: "commercial_unit" }, // custom catalogue value — must NOT count as commercial
];

describe("countUnitsByType", () => {
  test("counts exact type matches only", () => {
    expect(countUnitsByType(sample, "shop")).toBe(2);
    expect(countUnitsByType(sample, "commercial")).toBe(1);
    expect(countUnitsByType(sample, "apartment")).toBe(1);
  });

  test("does not treat commercial_unit as commercial", () => {
    expect(countUnitsByType(sample, "commercial")).toBe(1);
    expect(countUnitsByType(sample, "commercial_unit")).toBe(1);
  });

  test("returns 0 for empty list or no matches", () => {
    expect(countUnitsByType([], "shop")).toBe(0);
    expect(countUnitsByType(sample, "warehouse")).toBe(0);
  });
});
