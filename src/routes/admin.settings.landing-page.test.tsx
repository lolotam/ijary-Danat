/**
 * @vitest-environment jsdom
 *
 * يركّب شاشة إعدادات صفحة الهبوط ويتنقّل بين تبويباتها كلها.
 *
 * The screen was one 1,045-line component; it is now a route plus four panels
 * (plan row 6.7). Nothing else mounts it, so without this a panel that failed
 * to render, or a prop wired to the wrong tab, would only surface when an
 * operator opened the screen. Hooks are mocked at the data boundary; the
 * panels, tables and Radix tabs are real.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dictionaries, LOCALE_STORAGE_KEY } from "@/i18n/dictionary";
import { I18nProvider } from "@/i18n/provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const en = dictionaries.en;

/** طفرة وهمية تكفي لعرض الأزرار دون تنفيذ شيء. */
const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });

const settings = (locale: "ar" | "en") => ({
  id: `settings-${locale}`,
  company_id: "company-1",
  hero_title: `Hero ${locale}`,
  hero_subtitle: "Sub",
  hero_primary_cta_label: "",
  hero_primary_cta_target: "",
  hero_secondary_cta_label: "",
  hero_secondary_cta_target: "",
  about_title: "About",
  about_body: "Body",
  leasing_title: "Leasing",
  leasing_body: "Leasing body",
});

// Mutable so a test can drop landing_page.update and keep only .read.
const grants = { canUpdate: true };
vi.mock("@/hooks/usePermissions", () => ({
  usePermissions: () => ({
    isLoading: false,
    isStaff: true,
    isAdmin: grants.canUpdate,
    can: (code: string) => code !== "landing_page.update" || grants.canUpdate,
    canAny: () => true,
  }),
}));

vi.mock("@/hooks/useLandingSettings", () => ({
  useLandingSettings: (locale: "ar" | "en") => ({ data: settings(locale), isLoading: false }),
  useLandingSections: () => ({
    data: [
      { id: "s1", section_key: "shop_explorer", theme: "dark", enabled: true, settings_json: {} },
    ],
    isLoading: false,
  }),
  useLandingSlides: () => ({
    data: [
      {
        id: "slide-1",
        title_ar: "شريحة",
        title_en: "Slide one",
        media: null,
        mobile_media: null,
        is_active: true,
        display_order: 1,
      },
    ],
    isLoading: false,
  }),
  useLandingMedia: () => ({
    data: [{ id: "m1", storage_path: "https://x/y.jpg", show_in_gallery: true, display_order: 1 }],
    isLoading: false,
  }),
  useUpdateLandingSettings: mutation,
  useUpdateLandingSection: mutation,
  useCreateSlide: mutation,
  useUpdateSlide: mutation,
  useDeleteSlide: mutation,
  useCreateLandingMedia: mutation,
  useUpdateLandingMedia: mutation,
  useDeleteLandingMedia: mutation,
}));

vi.mock("@/hooks/useCompany", () => ({
  useCompany: () => ({ data: { id: "company-1", phone: "123" }, isLoading: false }),
  useUpdateCompany: mutation,
}));

// The shops tab has its own data layer and its own tests; stub it here.
vi.mock("@/components/admin/landing-page/AdminBrandDialog", () => ({
  AdminShopsSection: () => <div>shops-section</div>,
}));

vi.mock("@/components/admin/ImageSourceInput", () => ({
  ImageSourceInput: () => <input data-testid="image-source" />,
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (opts: { component: unknown }) => ({ options: opts }),
}));

const { Route } = await import("@/routes/admin.settings.landing-page");
const Screen = (Route as unknown as { options: { component: () => ReactElement } }).options
  .component;

let container: HTMLDivElement;
let root: Root;

/** يركّب الشاشة داخل مزوّد الترجمة بالإنجليزية. */
function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <I18nProvider>
        <Screen />
      </I18nProvider>,
    );
  });
}

/**
 * ينشّط تبويب Radix كما يفعل المستخدم.
 *
 * Radix `TabsTrigger` switches on a primary-button `mousedown`, not `click`.
 */
function openTab(label: string): void {
  const trigger = [...container.querySelectorAll('[role="tab"]')].find(
    (node) => node.textContent === label,
  );
  expect(trigger, `tab "${label}"`).toBeDefined();
  act(() => {
    trigger!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  });
}

beforeEach(() => {
  localStorage.setItem(LOCALE_STORAGE_KEY, "en");
  mount();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.removeItem(LOCALE_STORAGE_KEY);
  grants.canUpdate = true;
});

describe("landing-page settings screen", () => {
  it("renders every tab's panel from the data the route loads", () => {
    // Sections is the default tab.
    expect(container.textContent).toContain(en["landingSettings.pageSections"]);
    expect(container.textContent).toContain("shop explorer");

    openTab(en["landingSettings.heroAbout"]);
    expect(container.textContent).toContain(en["landingSettings.heroBannerSection"]);

    openTab(en["landingSettings.shops"]);
    expect(container.textContent).toContain("shops-section");

    openTab(en["landingSettings.slides"]);
    expect(container.textContent).toContain(en["landingSettings.midpointSliderSlides"]);

    openTab(en["landingSettings.gallery"]);
    expect(container.textContent).toContain(en["landingSettings.photoGallery"]);

    openTab(en["landingSettings.location"]);
    expect(container.textContent).toContain(en["landingSettings.locationContactDetails"]);
  });

  it("edits the English row after the editor language is switched", () => {
    // The text form is keyed on the edit language so its uncontrolled inputs
    // remount; without that the Arabic text would be saved over the English row.
    openTab(en["landingSettings.heroAbout"]);
    const heroTitle = () => container.querySelector<HTMLInputElement>("#hero_title")!;
    expect(heroTitle().value).toBe("Hero ar");

    const english = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === "English",
    );
    act(() => english!.click());

    expect(heroTitle().value).toBe("Hero en");
  });

  it("keeps a landing_page.read-only role out of every save, but lets it browse tabs", () => {
    // Migration 230: the landing tables only accept writes from
    // landing_page.update, so a read-only role must not reach a save RLS refuses.
    act(() => root.unmount());
    container.remove();
    grants.canUpdate = false;
    mount();

    expect(container.textContent).toContain(en["landingSettings.readOnlyNotice"]);

    openTab(en["landingSettings.heroAbout"]);
    expect(container.textContent).toContain(en["landingSettings.heroBannerSection"]);
    expect(container.querySelector("#hero_title")!.matches(":disabled")).toBe(true);
    const panelButtons = [...container.querySelectorAll('[role="tabpanel"] button')];
    expect(panelButtons.length).toBeGreaterThan(0);
    expect(panelButtons.every((b) => b.matches(":disabled"))).toBe(true);
  });

  it("leaves the editor enabled for a role holding landing_page.update", () => {
    openTab(en["landingSettings.heroAbout"]);
    expect(container.querySelector("#hero_title")!.matches(":disabled")).toBe(false);
    expect(container.textContent).not.toContain(en["landingSettings.readOnlyNotice"]);
  });
});
