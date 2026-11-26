/**
 * @vitest-environment jsdom
 *
 * The toggle's argument is computed inside the menu item's onSelect handler,
 * so this must be a real click through Radix — `renderToStaticMarkup` never
 * renders the portaled DropdownMenuContent, and the whole bug is in the
 * argument the handler passes. Same jsdom technique as
 * admin.settings.cards.test.tsx.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GalleryTable } from "@/components/admin/landing-page/GalleryTable";
import type { LandingMedia } from "@/hooks/useLandingSettings";
import { I18nProvider } from "@/i18n/provider";

// No @testing-library here: React's act() needs this flag to know it runs in
// a test environment, otherwise every call logs a warning (harmless but noisy).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * عنصر وسائط واحد بكل حقول الجدول، مع تجاوزات للحالات التي يفحصها الملف.
 *
 * Every key is typed against the real row so an invented field fails the
 * build instead of rendering `undefined`.
 */
function media(overrides: Partial<LandingMedia> = {}): LandingMedia {
  return {
    id: "m1",
    company_id: "comp-1",
    storage_path: "landing/gallery/one.jpg",
    mime_type: "image/jpeg",
    width: 800,
    height: 600,
    alt_ar: null,
    alt_en: null,
    caption_ar: null,
    caption_en: null,
    focal_x: 0.5,
    focal_y: 0.5,
    category: "gallery",
    show_in_gallery: true,
    is_active: true,
    display_order: 1,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const roots: Array<{ root: Root; container: HTMLDivElement }> = [];

/**
 * يركّب الجدول داخل مزوّد i18n حقيقي (العربية هي الافتراضية) في جذر React حي.
 *
 * The real I18nProvider rather than a mocked useI18n: the file also asserts
 * Arabic secondary text, and the provider is the cheapest way to keep locale
 * and rendered copy in step.
 */
function mountTable(items: LandingMedia[]) {
  const onToggleGalleryItem = vi.fn();
  const onDeleteMedia = vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider>
        <GalleryTable
          items={items}
          onToggleGalleryItem={onToggleGalleryItem}
          onDeleteMedia={onDeleteMedia}
        />
      </I18nProvider>,
    );
  });
  roots.push({ root, container });
  return { container, onToggleGalleryItem };
}

/**
 * يفتح قائمة إجراءات أول بطاقة عبر لوحة المفاتيح ثم يضغط البند المطلوب.
 *
 * Radix's trigger opens on ArrowDown keydown and its items select on a plain
 * click — the two events jsdom can dispatch without a pointer-events shim.
 */
function openMenuAndClick(itemText: string) {
  const trigger = document.querySelector('[aria-haspopup="menu"]');
  expect(trigger, "card actions trigger should render").toBeTruthy();
  act(() => {
    trigger!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );
  });
  const item = [...document.querySelectorAll('[role="menuitem"]')].find((el) =>
    el.textContent?.includes(itemText),
  );
  expect(item, `menu item "${itemText}" should render once the menu is open`).toBeTruthy();
  act(() => {
    item!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

afterEach(() => {
  while (roots.length) {
    const { root, container } = roots.pop()!;
    act(() => {
      root.unmount();
    });
    container.remove();
  }
});

describe("the in-gallery toggle", () => {
  it("an inactive but flagged row is offered OFF, not ON (the reported bug)", () => {
    const { onToggleGalleryItem } = mountTable([media({ is_active: false })]);

    openMenuAndClick("في المعرض");

    // Pre-fix this was (id, true): `shown` folded `is_active` in, so an
    // inactive-but-flagged row could never switch its flag off.
    expect(onToggleGalleryItem).toHaveBeenCalledWith("m1", false);
    expect(onToggleGalleryItem).toHaveBeenCalledTimes(1);
  });

  it("an active flagged row still toggles OFF", () => {
    const { onToggleGalleryItem } = mountTable([media({ is_active: true })]);

    openMenuAndClick("في المعرض");

    expect(onToggleGalleryItem).toHaveBeenCalledWith("m1", false);
  });

  it("an unflagged row is offered ON", () => {
    const { onToggleGalleryItem } = mountTable([
      media({ is_active: true, show_in_gallery: false }),
    ]);

    openMenuAndClick("في المعرض");

    expect(onToggleGalleryItem).toHaveBeenCalledWith("m1", true);
  });
});

describe("an inactive-but-flagged row stays readable", () => {
  it("shows the hidden-by-inactive hint on the card", () => {
    const { container } = mountTable([media({ is_active: false })]);

    expect(container.textContent).toContain("مخفي — العنصر غير مُفعّل");
  });

  it("shows no hint on an active row", () => {
    const { container } = mountTable([media({ is_active: true })]);

    expect(container.textContent).not.toContain("مخفي — العنصر غير مُفعّل");
  });
});

describe("the gallery empty state", () => {
  it("keeps the existing copy verbatim on the shared EmptyState", () => {
    const { container } = mountTable([]);

    // The copy is pinned character-for-character: it moved from an ad-hoc <p>
    // onto EmptyState, and "moved" must not become "reworded".
    expect(container.textContent).toContain("لا توجد صور معرض بعد. اضغط «إضافة صورة» للبدء.");
    // And it really is the shared component now, not a bare paragraph.
    expect(container.querySelector(".border-dashed")).not.toBeNull();
  });
});
