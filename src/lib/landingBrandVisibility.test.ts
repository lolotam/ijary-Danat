import { describe, expect, it } from "vitest";

import {
  filterExplorerBrands,
  filterMarqueeBrands,
  searchBrands,
  type LandingBrandRow,
} from "./landingBrandVisibility";

/**
 * صف محل مبسّط للاختبار، ظاهر في القسمين افتراضياً.
 *
 * Defaults both toggles ON so each test states only the flag it is about, and a
 * test that forgets to set one still describes today's default rather than an
 * accidental hidden shop.
 */
function brand(overrides: Partial<LandingBrandRow> & { name_en: string }): LandingBrandRow {
  return {
    name_ar: overrides.name_en,
    name_original: overrides.name_en,
    category_id: null,
    show_in_brands_marquee: true,
    show_in_shop_explorer: true,
    ...overrides,
  };
}

describe("filterMarqueeBrands / filterExplorerBrands", () => {
  it("hides a shop from the marquee without touching the explorer", () => {
    const rows = [
      brand({ name_en: "Zara", show_in_brands_marquee: false }),
      brand({ name_en: "Bershka" }),
    ];

    expect(filterMarqueeBrands(rows).map((b) => b.name_en)).toEqual(["Bershka"]);
    expect(filterExplorerBrands(rows).map((b) => b.name_en)).toEqual(["Zara", "Bershka"]);
  });

  it("hides a shop from the explorer without touching the marquee", () => {
    const rows = [
      brand({ name_en: "Zara", show_in_shop_explorer: false }),
      brand({ name_en: "Bershka" }),
    ];

    expect(filterExplorerBrands(rows).map((b) => b.name_en)).toEqual(["Bershka"]);
    expect(filterMarqueeBrands(rows).map((b) => b.name_en)).toEqual(["Zara", "Bershka"]);
  });

  it("drops a shop from both when both toggles are off", () => {
    const rows = [
      brand({ name_en: "Zara", show_in_brands_marquee: false, show_in_shop_explorer: false }),
    ];

    expect(filterMarqueeBrands(rows)).toEqual([]);
    expect(filterExplorerBrands(rows)).toEqual([]);
  });

  // A row read before migration 172 landed carries neither column. Treating
  // that as hidden would blank the public page for everyone with a warm cache.
  it("treats a missing or null column as visible", () => {
    // Built literally, not through `brand()`: the helper defaults both flags to
    // true, which would let this pass even if the absent-key case were broken.
    const absent: LandingBrandRow = {
      name_ar: "قديم",
      name_en: "Legacy",
      name_original: "Legacy",
      category_id: null,
    };
    const nulled: LandingBrandRow = {
      ...absent,
      show_in_brands_marquee: null,
      show_in_shop_explorer: null,
    };

    expect(filterMarqueeBrands([absent, nulled])).toHaveLength(2);
    expect(filterExplorerBrands([absent, nulled])).toHaveLength(2);
  });
});

describe("searchBrands", () => {
  const rows = [
    brand({ name_en: "Zara", name_ar: "زارا", category_id: "cat-fashion" }),
    brand({
      name_en: "Costa",
      name_ar: "كوستا",
      name_original: "Costa Coffee",
      category_id: "cat-cafe",
    }),
  ];

  it("matches on the Arabic, English and original names, case-insensitively", () => {
    expect(searchBrands(rows, { query: "ZAR", categoryId: "all" }).map((b) => b.name_en)).toEqual([
      "Zara",
    ]);
    expect(searchBrands(rows, { query: "كوستا", categoryId: "all" }).map((b) => b.name_en)).toEqual(
      ["Costa"],
    );
    expect(
      searchBrands(rows, { query: "coffee", categoryId: "all" }).map((b) => b.name_en),
    ).toEqual(["Costa"]);
  });

  it("narrows by category id, and 'all' means no category filter", () => {
    expect(searchBrands(rows, { query: "", categoryId: "cat-cafe" }).map((b) => b.name_en)).toEqual(
      ["Costa"],
    );
    expect(searchBrands(rows, { query: "", categoryId: "all" })).toHaveLength(2);
  });

  it("requires both the search and the category to match", () => {
    expect(searchBrands(rows, { query: "Zara", categoryId: "cat-cafe" })).toEqual([]);
  });

  // The route hands the raw input box through, so a stray space must not
  // silently empty the directory.
  it("ignores surrounding whitespace in the query", () => {
    expect(searchBrands(rows, { query: "  zara  ", categoryId: "all" })).toHaveLength(1);
  });
});
