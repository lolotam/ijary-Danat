import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// `t` resolves through the real catalog: the table's labels live there, and
// an identity `t` would make the copy assertions below compare keys.
vi.mock("@/i18n/provider", async () => {
  const { translatorFor } = await import("@/i18n/dictionary");
  return { useI18n: () => ({ locale: "en", t: translatorFor("en") }) };
});

import { SlidesTable } from "@/components/admin/landing-page/SlidesTable";
import type { SlideRow } from "@/components/admin/landing-page/SlidesTable";

/**
 * صف شريحة واحدة بكل حقول الجدول.
 *
 * Fully typed against the real row so an invented field fails the build
 * instead of rendering `undefined`.
 */
function slide(id: string): SlideRow {
  return {
    id,
    company_id: "c1",
    carousel_key: "main",
    media_id: "m1",
    mobile_media_id: null,
    title_ar: "الشريحة الأولى",
    title_en: "Slide One",
    description_ar: null,
    description_en: null,
    cta_label_ar: null,
    cta_label_en: null,
    cta_url: null,
    display_order: 1,
    is_active: true,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    media: null,
    mobile_media: null,
  };
}

/**
 * يرسم الجدول للشرائح المعطاة ويعيد الـ markup.
 */
function render(slides: SlideRow[] | undefined): string {
  return renderToStaticMarkup(
    <SlidesTable slides={slides} onEditSlide={vi.fn()} onDeleteSlide={vi.fn()} />,
  );
}

// Same trap as ShopsTable: undefined is loading, [] is empty. Gating on
// falsy-or-empty would flash the empty state on every page load.
describe("SlidesTable empty and loading states", () => {
  it("renders nothing but the grid while slides are undefined (loading)", () => {
    const markup = render(undefined);

    expect(markup).not.toContain("No slides yet");
    expect(markup).not.toContain("Slide One");
  });

  it("renders the empty state for an empty list", () => {
    const markup = render([]);

    expect(markup).toContain("No slides yet");
    expect(markup).toContain("Add Slide");
  });

  it("renders cards and no empty state for a populated list", () => {
    const markup = render([slide("s1")]);

    expect(markup).toContain("Slide One");
    expect(markup).not.toContain("No slides yet");
  });
});
