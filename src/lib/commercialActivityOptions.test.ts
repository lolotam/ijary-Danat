import { describe, expect, test } from "vitest";

import {
  catalogueLabelFor,
  mapCatalogueOptions,
  mapCommercialActivityOptions,
  SEEDED_COMMERCIAL_ACTIVITIES,
  SEEDED_PROPERTY_TYPES,
} from "@/lib/commercialActivityOptions";

/**
 * Regression guard for the Part B trap: if the form filtered catalogue items
 * against a hardcoded allow-list of the seven seeds (as `useListDrivenOptions`
 * does for enum-backed lists), every activity the owner later adds in
 * Settings → Lists would be invisible. This suite fails that bug.
 */
describe("mapCommercialActivityOptions — no hardcoded allow-list", () => {
  test("includes a catalogue value that is not one of the seven seeds", () => {
    const custom = {
      value: "electronics",
      label_ar: "إلكترونيات",
      label_en: "Electronics",
    };
    expect(SEEDED_COMMERCIAL_ACTIVITIES).not.toContain(custom.value);

    const options = mapCommercialActivityOptions(
      [{ value: "bakery", label_ar: "مخبز", label_en: "Bakery" }, custom],
      "en",
    );

    expect(options.map((o) => o.value)).toContain("electronics");
    expect(options).toEqual(
      expect.arrayContaining([{ value: "electronics", label: "Electronics" }]),
    );
  });

  test("picks label_ar when locale is ar", () => {
    const options = mapCommercialActivityOptions(
      [{ value: "salon", label_ar: "صالون", label_en: "Salon" }],
      "ar",
    );
    expect(options).toEqual([{ value: "salon", label: "صالون" }]);
  });

  test("falls back to value when both labels are empty", () => {
    const options = mapCommercialActivityOptions(
      [{ value: "custom_shop", label_ar: null, label_en: null }],
      "en",
    );
    expect(options).toEqual([{ value: "custom_shop", label: "custom_shop" }]);
  });
});

describe("property type options — free text after migration 103", () => {
  /**
   * Regression guard for the reported bug: catalogue items whose value is not
   * an old enum member must still reach the property type dropdown.
   */
  test("includes a catalogue value that is not an old enum member", () => {
    const custom = {
      value: "mall",
      label_ar: "مول",
      label_en: "Mall",
    };
    expect(SEEDED_PROPERTY_TYPES).not.toContain(custom.value);

    const options = mapCatalogueOptions(
      [{ value: "compound", label_ar: "مجمع", label_en: "Compound" }, custom],
      "en",
    );

    expect(options.map((o) => o.value)).toContain("mall");
    expect(options).toEqual(expect.arrayContaining([{ value: "mall", label: "Mall" }]));
  });
});

describe("catalogueLabelFor — the display side of the same catalogue", () => {
  const CATALOGUE = [
    { value: "apartment", label_ar: "شقة", label_en: "Apartment" },
    { value: "commercial_unit", label_ar: "وحدة تجارية", label_en: "Commercial Unit" },
  ];

  /**
   * `t()` returns the key itself for a missing key — silently. A translate stub
   * that only knows the seeds reproduces that exactly, which is the whole bug:
   * the units table rendered the literal string "unitType.commercial_unit".
   */
  const translate = (key: string) =>
    key === "unitType.apartment" ? "Apartment (dictionary)" : key;

  const labelFor = (
    items: Array<{ value: string; label_ar: string | null; label_en: string | null }>,
    locale: "ar" | "en",
    value: string,
  ) => catalogueLabelFor({ items, locale, value, translate, translatePrefix: "unitType" });

  test("prefers the catalogue label for the active locale", () => {
    expect(labelFor(CATALOGUE, "en", "commercial_unit")).toBe("Commercial Unit");
    expect(labelFor(CATALOGUE, "ar", "commercial_unit")).toBe("وحدة تجارية");
  });

  test("the catalogue wins over the dictionary when both have the value", () => {
    // Settings → Lists is the source of truth after migration 103; an admin who
    // renames a type there must see the rename, not the frozen dictionary copy.
    expect(labelFor(CATALOGUE, "en", "apartment")).toBe("Apartment");
  });

  test("falls back to the dictionary when the catalogue is unreadable", () => {
    // The tenant portal may hold no read policy on option_list_items, and the
    // catalogue is empty for one render while it loads. The seeds must survive.
    expect(labelFor([], "en", "apartment")).toBe("Apartment (dictionary)");
  });

  test("never renders the raw dictionary key", () => {
    // The reported bug, asserted directly: no catalogue row and no dictionary
    // entry must still not put "unitType.commercial_unit" on screen.
    expect(labelFor([], "en", "commercial_unit")).toBe("commercial_unit");
  });

  test("an empty catalogue label does not mask the dictionary", () => {
    const blank = [{ value: "apartment", label_ar: null, label_en: null }];
    expect(labelFor(blank, "en", "apartment")).toBe("Apartment (dictionary)");
  });
});
