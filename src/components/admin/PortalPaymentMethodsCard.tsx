import { useFormContext } from "react-hook-form";

import { FormControl, FormField, FormItem, FormLabel } from "@/components/ui/form";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/i18n/provider";

/** Fields this card owns inside the company settings form. */
export type PortalPaymentMethodsFormSlice = {
  portal_apple_pay_enabled: boolean;
  portal_google_pay_enabled: boolean;
};

/**
 * بطاقة وسائل الدفع في بوابة المستأجر: «كي‑نت» دائمًا، وآبل باي وجوجل باي اختياريان.
 *
 * There is no KNET switch, and the line naming it is not decoration: without it
 * an admin who turns both switches off has no confirmation that tenants can
 * still pay at all. The absence of that third control is the feature — it is
 * what makes an unpayable portal impossible to configure.
 *
 * A form-context consumer rather than a card with its own mutation, matching
 * `AnnouncementSettingsCard`: it shares the settings page's single save button,
 * and `useUpdateCompany` behind it already writes the audit row.
 */
export function PortalPaymentMethodsCard() {
  const { t } = useI18n();
  const { control } = useFormContext<PortalPaymentMethodsFormSlice>();

  return (
    <div className="space-y-4 rounded-xl border bg-card p-4 md:col-span-2">
      <div>
        <h3 className="text-base font-semibold leading-none tracking-tight">
          {t("settings.portalPaymentMethods.title")}
        </h3>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {t("settings.portalPaymentMethods.description")}
        </p>
      </div>

      <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
        {t("settings.portalPaymentMethods.knetAlways")}
      </div>

      <FormField
        control={control}
        name="portal_google_pay_enabled"
        render={({ field }) => (
          <FormItem className="flex flex-row items-center justify-between gap-3 rounded-lg border p-3">
            <FormLabel className="cursor-pointer">{t("portal.paymentMethod.googlepay")}</FormLabel>
            <FormControl>
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            </FormControl>
          </FormItem>
        )}
      />

      <FormField
        control={control}
        name="portal_apple_pay_enabled"
        render={({ field }) => (
          <FormItem className="flex flex-row items-center justify-between gap-3 rounded-lg border p-3">
            <div className="space-y-1">
              <FormLabel className="cursor-pointer">{t("portal.paymentMethod.applepay")}</FormLabel>
              <p className="text-xs text-muted-foreground">
                {t("settings.portalPaymentMethods.applePayDeviceNote")}
              </p>
            </div>
            <FormControl>
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            </FormControl>
          </FormItem>
        )}
      />
    </div>
  );
}
