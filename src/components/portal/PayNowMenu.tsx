import { Apple, CreditCard, Smartphone } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { HostedPaymentMethod } from "@/fns/createPayment";
import { useI18n } from "@/i18n/provider";
import { offeredPaymentMethods, type PaymentDeviceProfile } from "@/lib/paymentHandoff";

/**
 * أيقونة كل وسيلة دفع واسمها المعروض.
 *
 * Presentation only — which methods are actually offered is decided by
 * `offeredPaymentMethods`, from the admin's settings and the device's
 * capabilities. This map exists so a method that *is* offered can be drawn.
 */
const paymentMethodPresentation = {
  KNET: { icon: CreditCard, labelKey: "portal.paymentMethod.knet" },
  GOOGLE_PAY: { icon: Smartphone, labelKey: "portal.paymentMethod.googlepay" },
  APPLE_PAY: { icon: Apple, labelKey: "portal.paymentMethod.applepay" },
} as const satisfies Record<HostedPaymentMethod, { icon: typeof CreditCard; labelKey: string }>;

const PAY_BUTTON_CLASS = "min-h-14 w-full px-10 text-lg font-bold sm:w-auto";

/**
 * زر «ادفع الآن»: قائمة عند تعدد الوسائل، وزر مباشر عند وسيلة واحدة.
 *
 * Presentation only — `onSelect` is the same `paySelected` the page already
 * used, so handoff / QR / popup-blocked toasts stay wired exactly as before.
 *
 * The single-method branch exists because a dropdown holding one item is a
 * wasted tap on every payment an operator takes. It keys off the *offered*
 * count, never the admin's configured count: with Apple Pay enabled but the
 * tenant on an Android phone, two methods are configured and only KNET is
 * reachable — branching on the configured count would render the menu correctly
 * on a desktop and wrongly on exactly the devices tenants pay from.
 *
 * There is no empty state, and that is a property rather than an omission:
 * KNET is unconditional in `enabledPaymentMethods` and survives every device
 * filter, so `offered` cannot come back empty.
 */
export function PayNowMenu({
  device,
  enabled,
  isLoadingMethods,
  pendingMethod,
  onSelect,
}: {
  device: PaymentDeviceProfile;
  enabled: readonly HostedPaymentMethod[];
  isLoadingMethods: boolean;
  pendingMethod: HostedPaymentMethod | null;
  onSelect: (method: HostedPaymentMethod) => void;
}) {
  const { t } = useI18n();
  const busy = pendingMethod !== null;
  const offered = offeredPaymentMethods({ device, enabled });

  // Checked before the single-method branch: until the settings row loads there
  // is nothing to name, and guessing a provider would flip the label under the
  // tenant once the real answer arrives.
  if (isLoadingMethods) {
    return (
      <Button size="lg" className={PAY_BUTTON_CLASS} disabled>
        <CreditCard className="size-5" />
        {t("portal.invoices.payNowAction")}
      </Button>
    );
  }

  if (offered.length === 1) {
    const method = offered[0];
    const { icon: Icon, labelKey } = paymentMethodPresentation[method];
    return (
      <Button
        size="lg"
        className={PAY_BUTTON_CLASS}
        disabled={busy}
        onClick={() => onSelect(method)}
      >
        <Icon className="size-5" />
        {pendingMethod
          ? t("portal.gateway.redirecting")
          : `${t("portal.invoices.payNowAction")} · ${t(labelKey)}`}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="lg"
          className={PAY_BUTTON_CLASS}
          disabled={busy}
          aria-label={t("portal.invoices.choosePaymentMethod")}
        >
          <CreditCard className="size-5" />
          {pendingMethod ? t("portal.gateway.redirecting") : t("portal.invoices.payNowAction")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[12rem]">
        {offered.map((method) => {
          const { icon: Icon, labelKey } = paymentMethodPresentation[method];
          return (
            <DropdownMenuItem
              key={method}
              disabled={busy}
              className="min-h-11 cursor-pointer gap-2"
              onSelect={() => onSelect(method)}
            >
              <Icon className="size-4" />
              {pendingMethod === method ? t("portal.gateway.redirecting") : t(labelKey)}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
