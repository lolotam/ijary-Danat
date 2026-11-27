/**
 * @vitest-environment jsdom
 *
 * يختبر جدول حالة الشركات: الشارات السليمة والمعطوبة وغير المُعدّدة (T187).
 *
 * The strings are asserted from the Arabic module itself, so the test fails
 * when a label changes instead of accepting whatever the screen happens to
 * render.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { platformOverview } from "@/i18n/locales/ar/platformOverview";
import { I18nProvider } from "@/i18n/provider";
import type { PlatformCompanyHealth } from "@/platform/overview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { CompanyHealthTable } = await import("./CompanyHealthTable");

/** سطر شركة سليمة: كل شيء يعمل. */
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
};

/** سطر شركة معطوبة: اتصال مقطوع وبوابة فشل اختبارها وفشل متكرر. */
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
};

/** سطر شركة لم تُجهّز واتساب ولا بوابة دفع. */
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

  it("shows a healthy company with its working connections", () => {
    mount([HEALTHY]);

    expect(container.textContent).toContain(HEALTHY.name_ar);
    expect(container.textContent).toContain(HEALTHY.name_en);
    expect(container.textContent).toContain(platformOverview["platformOverview.state.ok"]);
    expect(container.textContent).toContain(platformOverview["platformOverview.status.active"]);
    expect(container.textContent).not.toContain(platformOverview["platformOverview.state.broken"]);
  });

  it("flags a degraded company with the broken item and its failure counts", () => {
    mount([DEGRADED]);

    expect(container.textContent).toContain(DEGRADED.name_ar);
    expect(container.textContent).toContain(platformOverview["platformOverview.state.broken"]);
    expect(container.textContent).toContain(platformOverview["platformOverview.status.suspended"]);
    expect(container.textContent).toContain("2");
    expect(container.textContent).toContain("3");
  });

  it("reads a company with no connection as not set up rather than broken", () => {
    mount([BARE]);

    expect(container.textContent).toContain(platformOverview["platformOverview.state.notSetUp"]);
    expect(container.textContent).not.toContain(platformOverview["platformOverview.state.broken"]);
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
