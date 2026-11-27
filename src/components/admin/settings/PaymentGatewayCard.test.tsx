/**
 * @vitest-environment jsdom
 *
 * بطاقة بوابات الدفع: الأسرار تُكتب ولا تُعرض، وآخر أربعة أحرف تُعرض،
 * والتفعيل يمرّ عبر دالة الخادم بعد تأكيد المستخدم.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LOCALE_STORAGE_KEY } from "@/i18n/dictionary";
import { gatewaySettingsUi } from "@/i18n/locales/ar/gatewaySettingsUi";
import { I18nProvider } from "@/i18n/provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  gatewayList: vi.fn(),
  gatewaySaveCredentials: vi.fn(),
  gatewayTestConnection: vi.fn(),
  gatewayActivate: vi.fn(),
  gatewayDeactivate: vi.fn(),
  gatewayConnectionIds: vi.fn(),
}));

// Server functions are the browser's transport boundary; React Query, the
// translation provider and the UI primitives stay real.
vi.mock("@/fns/gatewaySettings", () => ({
  gatewayList: mocks.gatewayList,
  gatewaySaveCredentials: mocks.gatewaySaveCredentials,
  gatewayTestConnection: mocks.gatewayTestConnection,
  gatewayActivate: mocks.gatewayActivate,
  gatewayDeactivate: mocks.gatewayDeactivate,
}));

vi.mock("@/fns/portalPaymentAvailability", () => ({
  PORTAL_PAYMENT_AVAILABILITY_KEY: ["portal-payment-availability"],
  portalPaymentAvailability: vi.fn(),
  gatewayConnectionIds: mocks.gatewayConnectionIds,
}));

const { PaymentGatewayCard } = await import("@/components/admin/settings/PaymentGatewayCard");

/** اتصال MyFatoorah كما يعيده سرد إعدادات البوابات، بسرّ مخزَّن واحد. */
const CONFIGURED_MYFATOORAH = {
  provider: "myfatoorah",
  configured: true,
  mode: "test",
  publicConfig: {},
  isActive: false,
  lastTestAt: "2026-11-27T10:00:00.000Z",
  lastTestOk: true,
  lastTestMessage: "ok",
  secretPreviews: [{ name: "apiKey", last4: "7890" }],
};

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

/** يركّب البطاقة داخل مزوّد ترجمة ومزوّد React Query حقيقيين. */
function mount(): void {
  localStorage.setItem(LOCALE_STORAGE_KEY, "ar");
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <PaymentGatewayCard />
        </I18nProvider>
      </QueryClientProvider>,
    );
  });
}

/** ينتظر دورات React حتى تستقر الحالة بعد طلب أو نقرة. */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

/** يبحث عن زرّ بنصّه العربي المترجم من مفتاح الترجمة ويضغطه. */
function clickButton(key: string): void {
  const label = gatewaySettingsUi[key];
  const button = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) throw new Error(`button not found: ${key}`);
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.gatewayList.mockResolvedValue([CONFIGURED_MYFATOORAH]);
  mocks.gatewayConnectionIds.mockResolvedValue({
    myfatoorah: "22222222-2222-4222-8222-222222222222",
    tap: null,
    upayments: null,
  });
  mocks.gatewayActivate.mockResolvedValue({
    provider: "myfatoorah",
    mode: "test",
    isActive: true,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  queryClient.clear();
});

describe("PaymentGatewayCard", () => {
  it("never prefills a stored secret and shows only its last four characters", async () => {
    mount();
    await flush();

    const secretInputs = [...container.querySelectorAll('input[type="password"]')];
    expect(secretInputs.length).toBeGreaterThan(0);
    expect(secretInputs.every((input) => (input as HTMLInputElement).value === "")).toBe(true);
    expect(container.textContent).toContain("7890");
    expect(container.textContent).toContain(
      "/api/public/webhooks/myfatoorah/22222222-2222-4222-8222-222222222222",
    );
  });

  it("activates the configured gateway through the server function after confirmation", async () => {
    mount();
    await flush();

    clickButton("gatewaySettingsUi.activate");
    await flush();
    clickButton("gatewaySettingsUi.confirm");
    await flush();

    expect(mocks.gatewayActivate).toHaveBeenCalledWith({ data: { provider: "myfatoorah" } });
  });

  it("shows the server's one-active-gateway refusal instead of hiding it", async () => {
    mocks.gatewayActivate.mockRejectedValueOnce(
      new Error("ONE_ACTIVE_GATEWAY: Another payment gateway is already active."),
    );
    mount();
    await flush();

    clickButton("gatewaySettingsUi.activate");
    await flush();
    clickButton("gatewaySettingsUi.confirm");
    await flush();

    expect(container.textContent).toContain(
      "ONE_ACTIVE_GATEWAY: Another payment gateway is already active.",
    );
  });
});
