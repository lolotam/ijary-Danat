/**
 * @vitest-environment jsdom
 *
 * يثبّت أن سجل الاشتراكات للقراءة والإضافة فقط، وأن النموذج يرفض التجديد قبل البدء.
 *
 * Only the server-function boundary is replaced: the panel's own date check is
 * what these scenarios exercise, so it must stay real.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { platformBilling } from "@/i18n/locales/ar/platformBilling";
import { I18nProvider } from "@/i18n/provider";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => ({
  fetchPlatformSubscriptions: vi.fn(),
  recordPlatformSubscription: vi.fn(),
}));

vi.mock("@/platform/platformFns", async (original) => ({
  ...(await original<typeof import("@/platform/platformFns")>()),
  fetchPlatformSubscriptions: mocks.fetchPlatformSubscriptions,
  recordPlatformSubscription: mocks.recordPlatformSubscription,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SubscriptionPanel } = await import("./SubscriptionPanel");

/** سطر اشتراك واحد كما يعيده سرد المنصة. */
const SUBSCRIPTION = {
  id: "33333333-3333-4333-8333-333333333333",
  company_id: COMPANY_ID,
  plan_name: "Business",
  price: 125.5,
  period_start: "2026-11-01",
  renewal_date: "2026-12-01",
  status: "active" as const,
  note: null,
  recorded_by: null,
  created_at: "2026-11-01T08:00:00.000Z",
};

let container: HTMLDivElement;
let root: Root;

/** يركّب لوحة الاشتراك داخل مزوّد الترجمة. */
function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <I18nProvider>
        <SubscriptionPanel companyId={COMPANY_ID} />
      </I18nProvider>,
    ),
  );
}

/** ينتظر استقرار التأثيرات والوعود بعد تفاعل. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

/** يضع قيمة في حقل تحكمه React ويطلق حدث الإدخال. */
function typeInto(selector: string, value: string): void {
  const input = document.querySelector(selector) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the subscription panel (T117)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchPlatformSubscriptions.mockResolvedValue([SUBSCRIPTION]);
    mocks.recordPlatformSubscription.mockResolvedValue(SUBSCRIPTION);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
  });

  it("shows one record action and no edit or delete action on append-only history", async () => {
    mount();
    await settle();

    expect(
      [...document.querySelectorAll("button")].map((button) => button.textContent?.trim()),
    ).toEqual([platformBilling["platformBilling.subscription.record"]]);
    expect(container.textContent).toContain("Business");
  });

  it("refuses a renewal date before the period start without calling the server", async () => {
    mount();
    await settle();

    typeInto("#platform-subscription-plan", "Starter");
    typeInto("#platform-subscription-price", "10.000");
    typeInto("#platform-subscription-start", "2026-12-01");
    typeInto("#platform-subscription-renewal", "2026-11-30");
    await act(async () =>
      document
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await settle();

    expect(mocks.recordPlatformSubscription).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      platformBilling["platformBilling.subscription.renewalBeforeStart"],
    );
  });
});
