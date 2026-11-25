import { describe, expect, it } from "vitest";

import {
  propertyDisplayName,
  propertyFilterOptions,
  sortPropertiesByCodeNatural,
} from "./propertyDisplayName";

describe("propertyDisplayName", () => {
  it("returns the Arabic name in Arabic regardless of name_en", () => {
    expect(propertyDisplayName({ name_ar: "برج الدانة", name_en: "Danat Tower" }, "ar")).toBe(
      "برج الدانة",
    );
  });

  it("returns name_en in English when present", () => {
    expect(propertyDisplayName({ name_ar: "برج الدانة", name_en: "Danat Tower" }, "en")).toBe(
      "Danat Tower",
    );
  });

  it("falls back to the Arabic name when name_en is missing or blank", () => {
    expect(propertyDisplayName({ name_ar: "برج الدانة", name_en: null }, "en")).toBe("برج الدانة");
    expect(propertyDisplayName({ name_ar: "برج الدانة", name_en: "   " }, "en")).toBe("برج الدانة");
    expect(propertyDisplayName({ name_ar: "برج الدانة" }, "en")).toBe("برج الدانة");
  });
});

describe("sortPropertiesByCodeNatural", () => {
  it.each([
    {
      scenario: "plain numbers",
      codes: ["10", "2", "1"],
      expected: ["1", "2", "10"],
    },
    {
      scenario: "prefixed codes",
      codes: ["P-10", "P-2", "P-1"],
      expected: ["P-1", "P-2", "P-10"],
    },
  ])("orders $scenario naturally: 1, 2, … 10", ({ codes, expected }) => {
    const properties = codes.map((code, index) => ({ id: `id-${index}`, code }));
    expect(sortPropertiesByCodeNatural(properties).map((property) => property.code)).toEqual(
      expected,
    );
  });

  it("does not mutate the input array", () => {
    const properties = [
      { id: "a", code: "2" },
      { id: "b", code: "1" },
    ];
    sortPropertiesByCodeNatural(properties);
    expect(properties.map((property) => property.code)).toEqual(["2", "1"]);
  });
});

describe("propertyFilterOptions", () => {
  it("returns options ordered by code: 1 at the top, 10 below", () => {
    const properties = [
      { id: "id-10", code: "10", name_ar: "العقار عشرة" },
      { id: "id-2", code: "2", name_ar: "العقار اثنان" },
      { id: "id-1", code: "1", name_ar: "العقار واحد" },
    ];
    expect(propertyFilterOptions(properties, "ar").map((option) => option.value)).toEqual([
      "id-1",
      "id-2",
      "id-10",
    ]);
  });
});
