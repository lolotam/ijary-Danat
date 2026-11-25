import { describe, expect, it } from "vitest";

import { joinLocalized } from "./localeList";

describe("joinLocalized", () => {
  // The defect this replaced: names localised correctly, then joined with the
  // other language's punctuation — "Test Unit، Shop 2" in an English session.
  it("uses the Arabic comma in Arabic and the Latin comma in English", () => {
    expect(joinLocalized(["محل ١", "محل ٢"], "ar")).toBe("محل ١، محل ٢");
    expect(joinLocalized(["Shop 1", "Shop 2"], "en")).toBe("Shop 1, Shop 2");
  });

  it("drops blank entries rather than leaving a dangling separator", () => {
    expect(joinLocalized(["Shop 1", "", "   ", "Shop 2"], "en")).toBe("Shop 1, Shop 2");
  });

  // Callers append `|| "—"`, so an all-blank list must produce a falsy string
  // for that fallback to fire.
  it("returns an empty string for an empty or all-blank list", () => {
    expect(joinLocalized([], "en")).toBe("");
    expect(joinLocalized(["", "  "], "ar")).toBe("");
  });
});
