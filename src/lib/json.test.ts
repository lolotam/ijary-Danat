import { describe, expect, test } from "vitest";

import { numberValue } from "@/lib/json";

describe("numberValue", () => {
  test("passes numbers through", () => {
    expect(numberValue(12.5)).toBe(12.5);
  });

  test("coerces numeric strings from jsonb", () => {
    expect(numberValue("100.000")).toBe(100);
  });

  test("treats null and undefined as zero", () => {
    expect(numberValue(null)).toBe(0);
    expect(numberValue(undefined)).toBe(0);
  });
});
