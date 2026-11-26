import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// The locale is mutable because one assertion below only means anything in
// Arabic — the duplicated-name bug it guards against was invisible under `en`.
// `useOptionalI18n` is stubbed too: the restored row view renders `<Table>`,
// which reads the context directly to set the table's `dir`, and an incomplete
// mock kills every row assertion inside table.tsx instead of failing on what it
// was checking.
const i18n = vi.hoisted(() => ({ locale: "en" as "ar" | "en" }));

// `t` resolves through the real catalog: the table's labels now live there,
// and an identity `t` would make every copy assertion below compare a key.
vi.mock("@/i18n/provider", async () => {
  const { translatorFor } = await import("@/i18n/dictionary");
  return {
    useI18n: () => ({ locale: i18n.locale, t: (key: string) => translatorFor(i18n.locale)(key) }),
    useOptionalI18n: () => ({
      locale: i18n.locale,
      dir: i18n.locale === "ar" ? "rtl" : "ltr",
      t: (key: string) => translatorFor(i18n.locale)(key),
    }),
  };
});

afterEach(() => {
  i18n.locale = "en";
});

import { joinContractLabels, ShopsTable } from "@/components/admin/landing-page/ShopsTable";
import type { BrandRow } from "@/components/admin/landing-page/ShopsTable";

/**
 * صف محل واحد بكل حقول الجدول.
 *
 * Fully typed against the real row so an invented field fails the build
 * instead of rendering `undefined`.
 */
function brand(id: string): BrandRow {
  return {
    id,
    company_id: "comp-1",
    property_id: "p1",
    unit_id: null,
    name_original: "Original",
    name_ar: "المحل الأول",
    name_en: "Brand One",
    slug: "brand-one",
    description_ar: null,
    description_en: null,
    category_id: null,
    logo_media_id: null,
    cover_media_id: null,
    phone: null,
    website_url: null,
    instagram_url: null,
    opening_hours_json: {},
    is_featured: false,
    is_active: true,
    show_in_brands_marquee: true,
    show_in_shop_explorer: true,
    display_order: 1,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    logo: null,
    cover: null,
  };
}

/**
 * يرسم الجدول للوسائط المعطاة ويعيد الـ markup.
 */
function render(brands: BrandRow[] | undefined): string {
  return renderToStaticMarkup(
    <ShopsTable
      brands={brands}
      contractLabelById={new Map()}
      contractIdsByBrand={new Map()}
      onEditBrand={vi.fn()}
      onDeleteBrand={vi.fn()}
    />,
  );
}

// `undefined` means loading and `[]` means empty — gating the empty state on
// falsy-or-empty would flash "No shops yet" on every page load. These three
// cases pin the distinction.
describe("ShopsTable empty and loading states", () => {
  it("renders nothing but the grid while brands are undefined (loading)", () => {
    const markup = render(undefined);

    expect(markup).not.toContain("No shops yet");
    expect(markup).not.toContain("Brand One");
  });

  it("renders the empty state for an empty list", () => {
    const markup = render([]);

    expect(markup).toContain("No shops yet");
    expect(markup).toContain("Add Store");
  });

  it("renders rows and no empty state for a populated list", () => {
    const markup = render([brand("b1")]);

    expect(markup).toContain("Brand One");
    expect(markup).not.toContain("No shops yet");
  });
});

// The row view is the default, and `renderToStaticMarkup` is exactly the server
// render whose output the client must match — so these also pin the absence of
// a hydration mismatch. A `useState` initialiser reading localStorage would
// still emit rows here while the client painted cards.
describe("ShopsTable view toggle", () => {
  it("defaults to the row view", () => {
    const markup = render([brand("b1")]);

    expect(markup).toContain("<table");
    expect(markup).toContain("Active Contract");
  });

  it("offers both views as an accessible radiogroup", () => {
    const markup = render([brand("b1")]);

    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain('aria-label="Rows"');
    expect(markup).toContain('aria-label="Cards"');
  });

  // The pre-card table printed `name_ar` in BOTH the Name and the Arabic Name
  // column whenever the UI was Arabic, making the pair useless in the product's
  // primary language. Under `en` the old code looked correct, so this has to
  // render in Arabic or it proves nothing.
  it("shows both languages in Arabic rather than repeating the Arabic name", () => {
    i18n.locale = "ar";

    const markup = render([brand("b1")]);

    expect(markup).toContain("المحل الأول");
    expect(markup).toContain("Brand One");
    expect(markup.match(/المحل الأول/g)).toHaveLength(1);
  });
});

/**
 * الترحيل 162 حوّل الربط إلى علاقة كثير-إلى-كثير، فصار للمحل عدة عقود.
 *
 * The cell is one truncated line, so the display has to stay bounded however
 * many leases a shop accumulates — and it has to keep NAMING the first few,
 * because "which lease is this shop on" is the whole question the column
 * answers. A bare count would not answer it.
 */
describe("joinContractLabels", () => {
  const labels = new Map([
    ["c1", "CON-0001 — ألفا"],
    ["c2", "CON-0002 — بيتا"],
    ["c3", "CON-0003 — غاما"],
    ["c4", "CON-0004 — دلتا"],
    ["c5", "CON-0005 — إبسيلون"],
  ]);

  it("names every contract while they still fit", () => {
    expect(joinContractLabels(["c1", "c2", "c3"], labels, "ar")).toBe(
      "CON-0001 — ألفا، CON-0002 — بيتا، CON-0003 — غاما",
    );
  });

  it("names the first three and counts the rest", () => {
    const joined = joinContractLabels(["c1", "c2", "c3", "c4", "c5"], labels, "ar");
    expect(joined).toBe("CON-0001 — ألفا، CON-0002 — بيتا، CON-0003 — غاما +2");
    // The overflow is a count, not a truncation of the fourth label — a cell
    // ending mid-name reads as a rendering bug.
    expect(joined).not.toContain("دلتا");
  });

  it("drops an id with no label instead of printing the raw uuid", () => {
    // The options list holds ACTIVE contracts only, so a link to an expired
    // lease has no label. A bare UUID in the cell reads as corruption.
    expect(joinContractLabels(["c1", "8bf4f1a6-8f3b-48fd-818e-82d5b2b3e5ca"], labels, "ar")).toBe(
      "CON-0001 — ألفا",
    );
  });

  it("separates with the locale's own comma, not always the Arabic one", () => {
    // The cell renders in whichever language the admin is reading. An Arabic
    // "،" between English contract codes is the kind of detail that reads as a
    // rendering fault rather than a choice.
    expect(joinContractLabels(["c1", "c2"], labels, "en")).toBe("CON-0001 — ألفا, CON-0002 — بيتا");
    expect(joinContractLabels(["c1", "c2"], labels, "ar")).toBe("CON-0001 — ألفا، CON-0002 — بيتا");
  });

  it("renders an unlinked shop as an empty cell, not as a stray separator", () => {
    expect(joinContractLabels([], labels, "ar")).toBe("");
  });
});
