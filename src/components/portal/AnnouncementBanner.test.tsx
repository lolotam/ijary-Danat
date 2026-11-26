import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { Company } from "@/hooks/useCompany";
import { useCompany } from "@/hooks/useCompany";
import { useI18n } from "@/i18n/provider";

import { AnnouncementBanner } from "./AnnouncementBanner";

vi.mock("@/hooks/useCompany", () => ({
  useCompany: vi.fn(),
}));

vi.mock("@/i18n/provider", () => ({
  useI18n: vi.fn(),
}));

/**
 * يبني شركة وهمية للاختبارات مع قيم افتراضية قابلة للتجاوز.
 */
function company(overrides: Partial<Company> = {}): Company {
  return {
    id: "company-1",
    name_ar: "شركة",
    name_en: "Co",
    address_ar: null,
    address_en: null,
    announcement_ar: null,
    announcement_en: null,
    announcement_enabled: false,
    audit_log_retention_days: null,
    notification_log_retention_days: null,
    bank_logo_url: null,
    bank_name: null,
    brand_accent: null,
    brand_primary: null,
    created_at: "2026-01-01T00:00:00Z",
    currency: "KWD",
    default_locale: "ar",
    email: null,
    facebook_url: null,
    favicon_url: null,
    iban: null,
    instagram_url: null,
    invoice_footer_ar: null,
    invoice_footer_en: null,
    logo_url: null,
    email_logo_url: null,
    map_url: null,
    max_visible_unpaid_invoices: 3,
    phone: null,
    phone_country_code: "965",
    portal_apple_pay_enabled: true,
    portal_bg_url: null,
    portal_google_pay_enabled: true,
    slug: "co-test-1",
    status: "active",
    suspended_at: null,
    suspended_by: null,
    suspended_reason: null,
    timezone: "Asia/Kuwait",
    updated_at: "2026-01-01T00:00:00Z",
    whatsapp: null,
    backup_daily_enabled: false,
    backup_weekly_enabled: false,
    ...overrides,
  };
}

/**
 * يضبط مخرجات useCompany / useI18n لمشهد اختبار واحد.
 */
function mockHooks(opts: {
  company: Company | null | undefined;
  isLoading?: boolean;
  locale?: "ar" | "en";
}) {
  const locale = opts.locale ?? "en";
  vi.mocked(useCompany).mockReturnValue({
    data: opts.company,
    isLoading: opts.isLoading ?? false,
    isError: false,
    error: null,
  } as ReturnType<typeof useCompany>);

  vi.mocked(useI18n).mockReturnValue({
    locale,
    dir: locale === "ar" ? "rtl" : "ltr",
    t: (key: string) => key,
    setLocale: () => {},
    toggle: () => {},
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AnnouncementBanner", () => {
  test("renders nothing when the banner is disabled", () => {
    mockHooks({
      company: company({
        announcement_enabled: false,
        announcement_en: "Office closed Friday",
      }),
      locale: "en",
    });

    expect(renderToStaticMarkup(<AnnouncementBanner />)).toBe("");
  });

  test("renders nothing when the active locale's text is blank", () => {
    mockHooks({
      company: company({
        announcement_enabled: true,
        announcement_en: "",
        announcement_ar: "إعلان",
      }),
      locale: "en",
    });

    expect(renderToStaticMarkup(<AnnouncementBanner />)).toBe("");
  });

  test("renders nothing while company is still loading", () => {
    mockHooks({ company: undefined, isLoading: true, locale: "en" });
    expect(renderToStaticMarkup(<AnnouncementBanner />)).toBe("");
  });

  test("renders the Arabic text in Arabic", () => {
    mockHooks({
      company: company({
        announcement_enabled: true,
        announcement_ar: "مكتب مغلق يوم الجمعة",
        announcement_en: "Office closed Friday",
      }),
      locale: "ar",
    });

    const html = renderToStaticMarkup(<AnnouncementBanner />);
    expect(html).toContain("مكتب مغلق يوم الجمعة");
    expect(html).not.toContain("Office closed Friday");
    expect(html).toContain('role="status"');
  });

  test("duplicates the text so the loop is seamless", () => {
    mockHooks({
      company: company({
        announcement_enabled: true,
        announcement_en: "Pay rent by the 5th",
      }),
      locale: "en",
    });

    const html = renderToStaticMarkup(<AnnouncementBanner />);
    // First copy is announced; second is aria-hidden so AT does not double-speak.
    expect(html).toMatch(/Pay rent by the 5th[\s\S]*aria-hidden="true"[\s\S]*Pay rent by the 5th/);
  });

  test("marks the marquee so reduced-motion stops it", () => {
    mockHooks({
      company: company({
        announcement_enabled: true,
        announcement_en: "Notice",
      }),
      locale: "en",
    });

    const html = renderToStaticMarkup(<AnnouncementBanner />);
    expect(html).toContain("motion-reduce:animate-none");
  });

  test("chooses LTR animation for English and RTL for Arabic", () => {
    mockHooks({
      company: company({
        announcement_enabled: true,
        announcement_en: "Notice EN",
        announcement_ar: "إشعار",
      }),
      locale: "en",
    });
    expect(renderToStaticMarkup(<AnnouncementBanner />)).toContain("animate-portal-marquee-ltr");

    mockHooks({
      company: company({
        announcement_enabled: true,
        announcement_en: "Notice EN",
        announcement_ar: "إشعار",
      }),
      locale: "ar",
    });
    expect(renderToStaticMarkup(<AnnouncementBanner />)).toContain("animate-portal-marquee-rtl");
  });

  test("root can shrink inside a flex header without pushing logout off-screen", () => {
    mockHooks({
      company: company({
        announcement_enabled: true,
        announcement_en: "A very long announcement that would otherwise overflow",
      }),
      locale: "en",
    });

    const html = renderToStaticMarkup(<AnnouncementBanner />);
    expect(html).toContain("min-w-0");
    expect(html).toContain("flex-1");
    expect(html).toContain("overflow-hidden");
  });
});
