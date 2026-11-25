import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/provider", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

// Radix portals the menu content out of the rendered tree, so a static render
// never sees the items. Replacing the primitives with plain elements is what
// makes the filtered list assertable without adding jsdom to the whole suite.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { PayNowMenu } from "@/components/portal/PayNowMenu";
import { enabledPaymentMethods } from "@/lib/paymentHandoff";

/**
 * يرسم القائمة بملف جهاز وإعدادات مشرف معيّنة ويعيد الشيفرة الناتجة.
 *
 * Goes through `enabledPaymentMethods` rather than hand-listing methods so a
 * test can never assert a configuration the settings row cannot produce — KNET
 * missing, most of all.
 */
function markupFor(
  device: { canUseApplePay: boolean; isPhone: boolean },
  settings: { applePay: boolean; googlePay: boolean } = { applePay: true, googlePay: true },
  isLoadingMethods = false,
) {
  return renderToStaticMarkup(
    <PayNowMenu
      device={device}
      enabled={enabledPaymentMethods(settings)}
      isLoadingMethods={isLoadingMethods}
      pendingMethod={null}
      onSelect={vi.fn()}
    />,
  );
}

const DESKTOP = { canUseApplePay: false, isPhone: false };
const ANDROID_PHONE = { canUseApplePay: false, isPhone: true };

describe("PayNowMenu device filtering", () => {
  it("omits Apple Pay on a phone that cannot open the sheet", () => {
    const markup = markupFor(ANDROID_PHONE);
    expect(markup).toContain("portal.paymentMethod.knet");
    expect(markup).toContain("portal.paymentMethod.googlepay");
    expect(markup).not.toContain("portal.paymentMethod.applepay");
  });

  it.each([
    ["a desktop without Apple Pay", DESKTOP],
    ["an iPhone in Safari", { canUseApplePay: true, isPhone: true }],
    ["a Mac with Apple Pay", { canUseApplePay: true, isPhone: false }],
  ] as const)("offers all three methods on %s", (_name, device) => {
    const markup = markupFor(device);
    expect(markup).toContain("portal.paymentMethod.knet");
    expect(markup).toContain("portal.paymentMethod.googlepay");
    expect(markup).toContain("portal.paymentMethod.applepay");
  });

  it("keeps the declared order: KNET, then Google Pay, then Apple Pay", () => {
    const markup = markupFor({ canUseApplePay: true, isPhone: false });
    expect(markup.indexOf("portal.paymentMethod.knet")).toBeLessThan(
      markup.indexOf("portal.paymentMethod.googlepay"),
    );
    expect(markup.indexOf("portal.paymentMethod.googlepay")).toBeLessThan(
      markup.indexOf("portal.paymentMethod.applepay"),
    );
  });
});

describe("PayNowMenu admin settings", () => {
  it("hides Google Pay when the admin turned it off", () => {
    const markup = markupFor(DESKTOP, { applePay: true, googlePay: false });
    expect(markup).toContain("portal.paymentMethod.knet");
    expect(markup).toContain("portal.paymentMethod.applepay");
    expect(markup).not.toContain("portal.paymentMethod.googlepay");
  });

  it("still offers KNET when the admin turned both extras off", () => {
    // KNET is not a switch — the settings row cannot take it away.
    const markup = markupFor(DESKTOP, { applePay: false, googlePay: false });
    expect(markup).toContain("portal.paymentMethod.knet");
    expect(markup).not.toContain("portal.paymentMethod.googlepay");
    expect(markup).not.toContain("portal.paymentMethod.applepay");
  });
});

describe("PayNowMenu single-method rendering", () => {
  it("names the provider on the button and opens no menu when only KNET is left", () => {
    const markup = markupFor(DESKTOP, { applePay: false, googlePay: false });
    expect(markup).toContain("portal.invoices.payNowAction");
    expect(markup).toContain("portal.paymentMethod.knet");
    // The dropdown branch is the only one that labels the trigger for a chooser;
    // its absence is what proves the tenant gets one press rather than two.
    expect(markup).not.toContain("portal.invoices.choosePaymentMethod");
  });

  it("collapses to the direct button when the device removes the only extra", () => {
    // Two methods configured, one reachable. Branching on the configured count
    // would render a one-item dropdown here — on a phone, which is where most
    // tenants pay.
    const markup = markupFor(ANDROID_PHONE, { applePay: true, googlePay: false });
    expect(markup).toContain("portal.paymentMethod.knet");
    expect(markup).not.toContain("portal.invoices.choosePaymentMethod");
  });

  it("keeps the chooser when two methods survive the device filter", () => {
    const markup = markupFor(ANDROID_PHONE, { applePay: true, googlePay: true });
    expect(markup).toContain("portal.invoices.choosePaymentMethod");
  });
});

describe("PayNowMenu loading state", () => {
  it("shows the plain Pay Now label and names no provider while settings load", () => {
    // Naming a provider here would flip the label under the tenant once the
    // real settings arrive.
    const markup = markupFor(DESKTOP, { applePay: false, googlePay: false }, true);
    expect(markup).toContain("portal.invoices.payNowAction");
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain("portal.paymentMethod.knet");
    expect(markup).not.toContain("portal.invoices.choosePaymentMethod");
  });
});
