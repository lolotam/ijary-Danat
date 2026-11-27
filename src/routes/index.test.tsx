/**
 * @vitest-environment jsdom
 *
 * يتحقق من التفاعلات التي تعبر الأقسام في صفحة الهبوط بعد تقسيمها.
 *
 * The page was one ~1,900-line component and is now a composition of section
 * components (plan row 6.8). Server rendering proved the markup unchanged, but
 * it cannot see the state that now crosses component boundaries: a brand
 * clicked in one section opens a dialog owned by the page, a photo clicked in
 * the gallery opens a lightbox that must answer the keyboard, the leasing
 * section opens a form that lives elsewhere. Those are the wires a split can
 * cut without a type error, so each is exercised here. Data hooks are mocked;
 * the sections, dialogs and Radix primitives are real.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dictionaries, LOCALE_STORAGE_KEY } from "@/i18n/dictionary";
import { I18nProvider } from "@/i18n/provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const en = dictionaries.en;

vi.mock("@/components/ThemeProvider", () => ({ useTheme: () => ({ theme: "dark" }) }));
vi.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/auth/AuthProvider", () => ({ useAuth: () => ({ user: null, signOut: vi.fn() }) }));
vi.mock("@/hooks/useMapEmbed", () => ({ useMapEmbed: () => ({ data: null }) }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createFileRoute: () => (options: unknown) => ({ options }),
  Link: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/hooks/useCompany", () => ({
  useCompany: () => ({ data: { name_en: "Danat", phone: "+96511111111" } }),
}));
vi.mock("@/hooks/useLandingSettings", () => ({
  useLandingSettings: () => ({ data: null }),
  useLandingSections: () => ({ data: undefined }),
  useLandingBrands: () => ({
    data: [
      {
        id: "b1",
        name_ar: "مخبز",
        name_en: "Bakery",
        name_original: "Bakery",
        category_id: "c1",
        description_en: "Fresh bread daily",
        show_on_marquee: false,
        show_in_explorer: true,
        is_active: true,
        opening_hours_json: null,
      },
      {
        id: "b2",
        name_ar: "صيدلية",
        name_en: "Pharmacy",
        name_original: "Pharmacy",
        category_id: "c1",
        show_on_marquee: false,
        show_in_explorer: true,
        is_active: true,
        opening_hours_json: null,
      },
    ],
  }),
  useLandingSlides: () => ({ data: [] }),
  useLandingMedia: () => ({
    data: [
      { id: "m1", storage_path: "/g1.jpg", show_in_gallery: true, caption_en: "First" },
      { id: "m2", storage_path: "/g2.jpg", show_in_gallery: true, caption_en: "Second" },
    ],
  }),
  useLandingCategories: () => ({ data: [{ id: "c1", name_ar: "أغذية", name_en: "Food" }] }),
}));

// The route component is now a host-based dispatcher (T087); the landing page
// it used to render is preserved as the exported `LandingPage` (off for every
// company until US13) and stays exactly what these interactions exercise.
const { LandingPage: Page } = await import("@/routes/index");

let container: HTMLDivElement;
let root: Root;

/** يجد زراً أو عنصراً بنصّه الكامل داخل المستند كله (النوافذ تُرسم خارج الحاوية). */
function byText(selector: string, text: string): HTMLElement {
  const match = [...document.body.querySelectorAll<HTMLElement>(selector)].find((node) =>
    node.textContent?.includes(text),
  );
  expect(match, `${selector} containing "${text}"`).toBeDefined();
  return match!;
}

/** يكتب في حقل متحكَّم به بالطريقة التي يلتقطها React. */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  // The location section defers its map until it scrolls into view.
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider>
        <Page />
      </I18nProvider>,
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.removeItem(LOCALE_STORAGE_KEY);
  vi.unstubAllGlobals();
});

describe("public landing page after the section split", () => {
  it("opens the brand dialog for a shop clicked in the explorer", () => {
    act(() => byText("#shops button", "Bakery").click());

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("Bakery");
    expect(dialog?.textContent).toContain("Fresh bread daily");
    expect(dialog?.textContent).toContain("Food");
  });

  it("narrows the explorer to the search text, which the explorer now owns", () => {
    const search = container.querySelector<HTMLInputElement>('#shops input[type="search"]')!;
    typeInto(search, "pharm");

    const names = [...container.querySelectorAll("#shops h3")].map((node) => node.textContent);
    expect(names).toEqual(["Pharmacy"]);
  });

  it("opens the lightbox from the gallery and steps through it by keyboard", () => {
    act(() => container.querySelectorAll<HTMLButtonElement>("#gallery button")[0].click());
    expect(document.body.textContent).toContain("1 / 2");

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    });
    expect(document.body.textContent).toContain("2 / 2");

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(document.body.textContent).not.toContain("2 / 2");
  });

  it("opens the leasing form from the leasing section", () => {
    act(() => byText("#leasing button", en["landing.leasing.cta"]).click());

    expect(document.body.textContent).toContain(en["landing.leasing.form.title"]);
    expect(document.body.querySelector("#request_type")).not.toBeNull();
  });
});
