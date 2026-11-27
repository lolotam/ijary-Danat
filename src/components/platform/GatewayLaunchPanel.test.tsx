/**
 * @vitest-environment jsdom
 *
 * يختبر لوحة تبديل الوضع الفعلي لبوابات الدفع مع حوار التأكيد المرجعي لمعيار SC-012.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { gatewayLaunch } from "@/i18n/locales/ar/gatewayLaunch";
import { I18nProvider } from "@/i18n/provider";
import type { GatewayLaunchStatus } from "@/platform/gateways";

const mocks = vi.hoisted(() => ({
  fetchPlatformGatewayLaunch: vi.fn(),
  setPlatformGatewayLiveAllowed: vi.fn(),
}));

vi.mock("@/platform/gatewaysFns", () => ({
  fetchPlatformGatewayLaunch: mocks.fetchPlatformGatewayLaunch,
  setPlatformGatewayLiveAllowed: mocks.setPlatformGatewayLiveAllowed,
}));

vi.mock("@/i18n/locales/ar", async (original) => ({
  ar: {
    ...(await original<typeof import("@/i18n/locales/ar")>()).ar,
    ...gatewayLaunch,
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { GatewayLaunchPanel } = await import("./GatewayLaunchPanel");

const INITIAL_ROWS: GatewayLaunchStatus[] = [
  {
    provider: "myfatoorah",
    live_allowed: false,
    checklist_note: null,
    updated_by: null,
    updated_at: "2026-11-27T10:00:00.000Z",
    live_connections: 0,
  },
  {
    provider: "tap",
    live_allowed: true,
    checklist_note: null,
    updated_by: null,
    updated_at: "2026-11-27T10:00:00.000Z",
    live_connections: 3,
  },
  {
    provider: "upayments",
    live_allowed: false,
    checklist_note: null,
    updated_by: null,
    updated_at: "2026-11-27T10:00:00.000Z",
    live_connections: 0,
  },
];

let container: HTMLDivElement;
let root: Root;

/** يركّب لوحة بوابات الدفع داخل مزوّد الترجمة العربية. */
function mount(): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <I18nProvider>
        <GatewayLaunchPanel />
      </I18nProvider>,
    ),
  );
}

/** ينتظر استقرار التأثيرات والوعود بعد التفاعل. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("GatewayLaunchPanel (T151)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchPlatformGatewayLaunch.mockResolvedValue(INITIAL_ROWS);
    const { live_connections: _ignored, ...savedRow } = INITIAL_ROWS[0];
    mocks.setPlatformGatewayLiveAllowed.mockResolvedValue({ ...savedRow, live_allowed: true });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.replaceChildren();
  });

  it("renders all three providers in Arabic with their initial live-mode status", async () => {
    mount();
    await settle();

    expect(container.textContent).toContain(gatewayLaunch["platformGateways.provider.myfatoorah"]);
    expect(container.textContent).toContain(gatewayLaunch["platformGateways.provider.tap"]);
    expect(container.textContent).toContain(gatewayLaunch["platformGateways.provider.upayments"]);
    expect(container.textContent).toContain(gatewayLaunch["platformGateways.status.blocked"]);
    expect(container.textContent).toContain(gatewayLaunch["platformGateways.status.allowed"]);
  });

  it("opens the SC-012 confirmation dialog on switch click and only saves after confirm", async () => {
    mount();
    await settle();

    const myfatoorahSwitch = document.querySelector(
      "#platform-gateway-myfatoorah",
    ) as HTMLButtonElement;
    expect(myfatoorahSwitch).not.toBeNull();

    await act(async () => {
      myfatoorahSwitch.click();
    });
    await settle();

    expect(mocks.setPlatformGatewayLiveAllowed).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      gatewayLaunch["platformGateways.confirmBodyEnable"],
    );
    expect(document.body.textContent).toContain("SC-012");

    const confirmButton = [...document.querySelectorAll("button")].find(
      (btn) => btn.textContent?.trim() === gatewayLaunch["platformGateways.confirmAction"],
    );
    expect(confirmButton).toBeDefined();

    await act(async () => {
      confirmButton!.click();
    });
    await settle();

    expect(mocks.setPlatformGatewayLiveAllowed).toHaveBeenCalledWith({
      provider: "myfatoorah",
      allowed: true,
    });
    expect(container.textContent).toContain(gatewayLaunch["platformGateways.saved"]);
  });

  it("shows each provider's live company count and names it in the disable confirmation", async () => {
    mount();
    await settle();

    const tapLine = gatewayLaunch["platformGateways.liveConnections"].replace("{count}", "3");
    expect(container.textContent).toContain(tapLine);

    const tapSwitch = document.querySelector("#platform-gateway-tap") as HTMLButtonElement;
    await act(async () => {
      tapSwitch.click();
    });
    await settle();

    expect(document.body.textContent).toContain(
      gatewayLaunch["platformGateways.confirmBodyDisable"].replace("{count}", "3"),
    );
    expect(mocks.setPlatformGatewayLiveAllowed).not.toHaveBeenCalled();
  });

  it("shows a translated error alert when loading fails", async () => {
    mocks.fetchPlatformGatewayLaunch.mockRejectedValue(new Error("boom"));

    mount();
    await settle();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(gatewayLaunch["platformGateways.loadError"]);
  });
});
