import { renderToStaticMarkup } from "react-dom/server";
import { FormProvider, useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/i18n/provider", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import {
  PortalPaymentMethodsCard,
  type PortalPaymentMethodsFormSlice,
} from "@/components/admin/PortalPaymentMethodsCard";

/**
 * يرسم البطاقة داخل نموذج بقيم محددة ويعيد الشيفرة الناتجة.
 */
function markupFor(values: PortalPaymentMethodsFormSlice) {
  function Harness() {
    const form = useForm<PortalPaymentMethodsFormSlice>({ defaultValues: values });
    return (
      <FormProvider {...form}>
        <PortalPaymentMethodsCard />
      </FormProvider>
    );
  }
  return renderToStaticMarkup(<Harness />);
}

const BOTH_ON = { portal_apple_pay_enabled: true, portal_google_pay_enabled: true };

describe("PortalPaymentMethodsCard", () => {
  it("offers a switch for each optional method", () => {
    const markup = markupFor(BOTH_ON);
    expect(markup).toContain("portal.paymentMethod.googlepay");
    expect(markup).toContain("portal.paymentMethod.applepay");
  });

  // The invariant the whole feature rests on: KNET cannot be configured away,
  // which is what makes an unpayable portal impossible to save. A future
  // "make everything consistent" edit adding a third switch would quietly
  // reintroduce the empty-payment-menu state this design removed. Checked with
  // both extras off too, since that is the configuration where an admin most
  // needs telling that tenants can still pay.
  it.each([
    ["both extras on", BOTH_ON],
    ["both extras off", { portal_apple_pay_enabled: false, portal_google_pay_enabled: false }],
  ] as const)("exposes no KNET switch and says so, with %s", (_name, values) => {
    const markup = markupFor(values);
    expect(markup).toContain("settings.portalPaymentMethods.knetAlways");
    expect(markup).not.toContain('name="portal_knet_enabled"');
    expect(markup).not.toContain("portal.paymentMethod.knet");
  });
});
