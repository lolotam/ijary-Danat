import { describe, expect, test } from "vitest";

import { unitCsvNames, unitDisplayName } from "./unitDisplayName";

describe("unitCsvNames", () => {
  test("emits distinct Arabic and English columns", () => {
    // The regression this guards: before migration 54 units had a single `name`
    // column, so both CSV columns carried the same value.
    expect(unitCsvNames({ name: "وحدة ١", name_en: "Unit 1" })).toEqual({
      ar: "وحدة ١",
      en: "Unit 1",
    });
  });

  test("falls back rather than exporting a blank English column", () => {
    expect(unitCsvNames({ name: "وحدة ١", name_en: null })).toEqual({
      ar: "وحدة ١",
      en: "وحدة ١",
    });
  });

  test("an unconnected unit exports empty strings, not the literal null", () => {
    expect(unitCsvNames(null)).toEqual({ ar: "", en: "" });
    expect(unitCsvNames(undefined)).toEqual({ ar: "", en: "" });
  });
});

describe("unitDisplayName", () => {
  const UNIT = { name: "محل تجريبي", name_en: "Test Unit", code: "UNIT-00156" };

  test("returns the Arabic name in Arabic regardless of name_en", () => {
    expect(unitDisplayName(UNIT, "ar")).toBe("محل تجريبي");
  });

  test("returns name_en in English when present", () => {
    expect(unitDisplayName(UNIT, "en")).toBe("Test Unit");
  });

  test("falls back to the Arabic name when name_en is missing or blank", () => {
    expect(unitDisplayName({ ...UNIT, name_en: null }, "en")).toBe("محل تجريبي");
    expect(unitDisplayName({ ...UNIT, name_en: "   " }, "en")).toBe("محل تجريبي");
    expect(unitDisplayName({ name: "محل تجريبي", code: "UNIT-00156" }, "en")).toBe("محل تجريبي");
  });

  // The portal rendered `unit.name ?? unit.code`. `name` is NOT NULL, so that
  // fallback never fired — an empty name printed nothing at all, reaching the
  // tenant as a blank field with no identifier to quote to the office.
  test("falls back to the code when both names are empty", () => {
    expect(unitDisplayName({ name: "", name_en: "", code: "UNIT-00156" }, "en")).toBe("UNIT-00156");
    expect(unitDisplayName({ name: "", name_en: "", code: "UNIT-00156" }, "ar")).toBe("UNIT-00156");
  });
});
