import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/provider", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

import { PayNowMenu } from "@/components/portal/PayNowMenu";
import { enabledPaymentMethods } from "@/lib/paymentHandoff";

/**
 * السمة `disabled` كما يُخرجها React في الترميز الساكن، وليس مجرد الكلمة.
 *
 * Matching the bare word `disabled` is vacuous here: `buttonVariants` in
 * `src/components/ui/button.tsx` hardcodes `disabled:pointer-events-none
 * disabled:opacity-50 disabled:cursor-not-allowed`, so the substring is present
 * on every render regardless of state. Asserting on the serialised attribute is
 * what actually distinguishes an enabled trigger from a disabled one.
 */
const DISABLED_ATTRIBUTE = 'disabled=""';

const ALL_METHODS = enabledPaymentMethods({ applePay: true, googlePay: true });

describe("PayNowMenu", () => {
  it("shows a Pay Now trigger and does not list methods until opened", () => {
    // Closed DropdownMenu content is portaled and not in static markup; the
    // closed-state contract is "one Pay Now control, no method buttons".
    const markup = renderToStaticMarkup(
      <PayNowMenu
        device={{ canUseApplePay: false, isPhone: false }}
        enabled={ALL_METHODS}
        isLoadingMethods={false}
        pendingMethod={null}
        onSelect={vi.fn()}
      />,
    );
    expect(markup).toContain("portal.invoices.payNowAction");
    expect(markup).toContain("portal.invoices.choosePaymentMethod");
    expect(markup).not.toContain("portal.paymentMethod.knet");
    expect(markup).not.toContain("portal.paymentMethod.googlepay");
    expect(markup).not.toContain("portal.paymentMethod.applepay");
    expect(markup).not.toContain(DISABLED_ATTRIBUTE);
  });

  it("disables the trigger while a payment is in flight", () => {
    const markup = renderToStaticMarkup(
      <PayNowMenu
        device={{ canUseApplePay: false, isPhone: false }}
        enabled={ALL_METHODS}
        isLoadingMethods={false}
        pendingMethod="KNET"
        onSelect={vi.fn()}
      />,
    );
    expect(markup).toContain(DISABLED_ATTRIBUTE);
  });

  it("disables the single-method button while a payment is in flight", () => {
    // The direct-pay branch is a plain Button rather than a DropdownMenuTrigger,
    // so it carries its own disabled wiring that the branch above does not cover.
    const markup = renderToStaticMarkup(
      <PayNowMenu
        device={{ canUseApplePay: false, isPhone: false }}
        enabled={enabledPaymentMethods({ applePay: false, googlePay: false })}
        isLoadingMethods={false}
        pendingMethod="KNET"
        onSelect={vi.fn()}
      />,
    );
    expect(markup).toContain(DISABLED_ATTRIBUTE);
    expect(markup).toContain("portal.gateway.redirecting");
  });

  it("uses the exact MyFatoorah method strings", () => {
    // `satisfies Record<HostedPaymentMethod, …>` already makes a misspelled key
    // a type error, but typecheck is a separate gate from the suite — and the
    // underscore spelling fails at the gateway rather than at the boundary, so
    // it is worth pinning in a test that runs on every `bun run test`.
    const source = readFileSync(
      join(process.cwd(), "src/components/portal/PayNowMenu.tsx"),
      "utf8",
    );
    expect(source).toMatch(/^\s*KNET:/m);
    expect(source).toMatch(/^\s*GOOGLE_PAY:/m);
    expect(source).toMatch(/^\s*APPLE_PAY:/m);
    expect(source).toMatch(/onSelect\(method\)/);
  });
});
