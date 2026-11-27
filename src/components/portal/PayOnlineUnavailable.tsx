import { Info } from "lucide-react";

import { useI18n } from "@/i18n/provider";

/**
 * ملاحظة بوابة المستأجر حين لا يوجد اتصال دفع إلكتروني نشط للشركة.
 *
 * The note replaces the online payment controls rather than sitting beside
 * them: a renter who cannot pay online is told where to pay instead of being
 * invited to start a payment the company cannot settle.
 */
export function PayOnlineUnavailable() {
  const { t } = useI18n();

  return (
    <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-300">
      <Info className="mt-0.5 size-4 shrink-0" />
      {t("gatewaySettingsUi.portal.payAtOffice")}
    </p>
  );
}
