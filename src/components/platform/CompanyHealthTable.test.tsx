/**
 * @vitest-environment jsdom
 *
 * يختبر جدول حالة الشركات: الشارات السليمة والمعطوبة، والتحصيل، واستهلاك الحدود، والاشتراك (T187 / FR-074).
 *
 * The strings are asserted from the Arabic modules where already wired in `ar.ts`,
 * so the test fails when a label changes instead of accepting whatever the screen
 * happens to render.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { limitsUi } from "@/i18n/locales/ar/limitsUi";
import { platformBilling } from "@/i18n/locales/ar/platformBilling";
import { platformOverview } from "@/i18n/locales/ar/platformOverview";
import { I18nProvider } from "@/i18n/provider";
import type { PlatformCompanyHealth } from "@/platform/overview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { CompanyHealthTable } = await import("./CompanyHealthTable");

/** سطر شركة سليمة: كل شيء يعمل مع حدود مفعّلة واشتراك نشط. */
const HEALTHY: PlatformCompanyHealth = {
  company_id: "11111111-1111-4111-8111-111111111111",
  slug: "healthy",
  name_ar: "شركة سليمة",
  name_en: "Healthy Co",
  status: "active",
  whatsapp_ok: true,
  gateway_ok: true,
  jobs_failed_24h: 0,
  notifications_failed_24h: 0,
  collected_this_month: 125.5,
  units_used: 2,
  units_max: 10,
  staff_used: 1,
  staff_max: 5,
  whatsapp_used: 42,
  whatsapp_max: 100,
  storage_bytes: 2_048,
  storage_max: 104_857_600,
  subscription_status: "active",
  subscription_renewal_date: "2027-01-15",
};

/** سطر شركة معطوبة: اتصال مقطوع واستهلاك يقترب من 80% واشتراك متأخر. */
const DEGRADED: PlatformCompanyHealth = {
  company_id: "22222222-2222-4222-8222-222222222222",
  slug: "degraded",
  name_ar: "شركة معطوبة",
  name_en: "Degraded Co",
  status: "suspended",
  whatsapp_ok: false,
  gateway_ok: false,
  jobs_failed_24h: 2,
  notifications_failed_24h: 3,
  collected_this_month: 0,
  units_used: 8,
  units_max: 10,
  staff_used: 4,
  staff_max: 5,
  whatsapp_used: 90,
  whatsapp_max: 100,
  storage_bytes: 850_000_000,
  storage_max: 1_073_741_824,
  subscription_status: "overdue",
  subscription_renewal_date: "2026-01-01",
};

/** سطر شركة لم تُجهّز واتساب ولا بوابة دفع وبلا حدود أو اشتراك. */
const BARE: PlatformCompanyHealth = {
  company_id: "33333333-3333-4333-8333-333333333333",
  slug: "bare",
  name_ar: "شركة بلا إعدادات",
  name_en: "Bare Co",
  status: "active",
  whatsapp_ok: null,
  gateway_ok: null,
  jobs_failed_24h: 0,
  notifications_failed_24h: 0,
  collected_this_month: 0,
  units_used: 0,
  units_max: null,
  staff_used: 0,
  staff_max: null,
  whatsapp_used: 0,
  whatsapp_max: null,
  storage_bytes: 0,
  storage_max: null,
  subscription_status: null,
  subscription_renewal_date: null,
};

let container: HTMLDivElement;
let root: Root;

/** يركّب جدول حالة الشركات داخل مزوّد الترجمة العربية. */
function mount(rows: PlatformCompanyHealth[], error: string | null = null): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <I18nProvider>
        <CompanyHealthTable rows={rows} loading={false} error={error} />
      </I18nProvider>,
    ),
  );
}

describe("the company health table (T187)", () => {
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
  });

  it("shows a healthy company with its working connections, money, usage and subscription", () => {
    mount([HEALTHY]);

    expect(container.textContent).toContain(HEALTHY.name_ar);
    expect(container.textContent).toContain(HEALTHY.name_en);
    expect(container.textContent).toContain(platformOverview["platformOverview.state.ok"]);
    expect(container.textContent).toContain(platformOverview["platformOverview.status.active"]);
    expect(container.textContent).not.toContain(platformOverview["platformOverview.state.broken"]);
    expect(container.textContent).toContain("125.500 KWD");
    expect(container.textContent).toContain("2 / 10");
    expect(container.textContent).toContain("1 / 5");
    expect(container.textContent).toContain("42 / 100");
    expect(container.textContent).toContain("2");
    expect(container.textContent).toContain("100");
    expect(container.textContent).toContain(
      platformBilling["platformBilling.subscription.status.active"],
    );
    expect(container.textContent).toContain("2027-01-15");
    expect(container.querySelectorAll('[data-near-limit="true"]')).toHaveLength(0);
  });

  it("flags a degraded company with broken items, near-limit usage at 80%+, and overdue subscription", () => {
    mount([DEGRADED]);

    expect(container.textContent).toContain(DEGRADED.name_ar);
    expect(container.textContent).toContain(platformOverview["platformOverview.state.broken"]);
    expect(container.textContent).toContain(platformOverview["platformOverview.status.suspended"]);
    expect(container.textContent).toContain("0.000 KWD");
    expect(container.textContent).toContain("8 / 10");
    expect(container.textContent).toContain("4 / 5");
    expect(container.textContent).toContain("90 / 100");
    expect(container.textContent).toContain(
      platformBilling["platformBilling.subscription.status.overdue"],
    );
    expect(container.textContent).toContain("2026-01-01");
    // Units (8/10 = 80%), staff (4/5 = 80%), and WhatsApp (90/100 = 90%) are >= 80%;
    // storage (850 MB / 1 GB = 79.16%) is below 80%.
    expect(container.querySelectorAll('[data-near-limit="true"]')).toHaveLength(3);
  });

  it("reads a company with no connection, unlimited quotas, and no subscription", () => {
    mount([BARE]);

    expect(container.textContent).toContain(platformOverview["platformOverview.state.notSetUp"]);
    expect(container.textContent).not.toContain(platformOverview["platformOverview.state.broken"]);
    expect(container.textContent).toContain(limitsUi["limitsUi.unlimited"]);
    expect(container.textContent).toContain("—");
    expect(container.querySelectorAll('[data-near-limit="true"]')).toHaveLength(0);
  });

  it("says so when the platform holds no company at all", () => {
    mount([]);

    expect(container.textContent).toContain(platformOverview["platformOverview.health.empty"]);
  });

  it("shows the read failure instead of an empty table", () => {
    mount([], "تعذّر قراءة حالة المنصة.");

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "تعذّر قراءة حالة المنصة.",
    );
  });
});
