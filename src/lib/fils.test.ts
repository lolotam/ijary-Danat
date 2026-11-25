import { describe, expect, it } from "vitest";

import { roundToFils } from "@/lib/fils";

describe("roundToFils", () => {
  it.each([
    ["rounds up at the half-fils", 1.0005, 1.001],
    ["rounds down below the half-fils", 1.0004, 1],
    ["keeps a value already on a fils", 12.345, 12.345],
    ["handles zero", 0, 0],
    ["rounds a negative value toward the nearest fils", -2.3456, -2.346],
  ])("%s", (_label, input, expected) => {
    expect(roundToFils(input)).toBe(expected);
  });

  it("lands a floating-point sum on the value Postgres would store", () => {
    // 0.1 + 0.2 is 0.30000000000000004 in IEEE-754; numeric(14,3) stores 0.300.
    expect(roundToFils(0.1 + 0.2)).toBe(0.3);
  });

  it("clears the residue a subtraction leaves, so a settled balance reads as zero", () => {
    // 100.3 - 100.2 - 0.1 is -2.7e-14 in floating point; Postgres stores 0.000.
    // It comes back as -0, which `===`, `<=` and `> 0` all treat as zero —
    // every caller compares, none uses Object.is — so assert what they see.
    expect(roundToFils(100.3 - 100.2 - 0.1) === 0).toBe(true);
  });
});
