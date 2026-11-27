import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  companySubscriptionBanner,
  type CompanySubscriptionBannerData,
} from "@/fns/companySubscriptionBanner";
import { useI18n } from "@/i18n/provider";

/** آخر علامة عرض قبل موعد التجديد، بتوقيت الشركة. */
export const RENEWAL_BANNER_WINDOW_DAYS = 14;

/** ما يعرضه الشريط: بيانات اشتراك الشركة كما يعيدها استعلام الخادم. */
export interface SubscriptionBannerProps {
  subscription: CompanySubscriptionBannerData | null;
}

/**
 * شريط تحذير في لوحة الشركة عند اقتراب التجديد أو بعده.
 *
 * The server function returns the day count for every company with a record;
 * hiding outside the 14-day window belongs here so the rule lives next to the
 * copy it controls. The banner is never dismissible — until a renewal is
 * recorded the warning stays true.
 */
export function SubscriptionBanner({ subscription }: SubscriptionBannerProps) {
  const { t } = useI18n();

  if (!subscription) return null;
  const { daysLeft, endsOn, overdue } = subscription;
  if (!overdue && daysLeft > RENEWAL_BANNER_WINDOW_DAYS) return null;

  const headline = overdue
    ? t("admin.subscriptionBanner.overdue")
    : daysLeft === 0
      ? t("admin.subscriptionBanner.today")
      : t("admin.subscriptionBanner.endingSoon").replace("{days}", String(daysLeft));
  const renewalDate = t("admin.subscriptionBanner.endsOn").replace("{date}", endsOn);

  return (
    <Alert
      role="status"
      className="rounded-none border-x-0 border-t-0 border-b border-amber-500/40 bg-amber-50/90 px-4 py-2.5 text-amber-950 dark:border-amber-500/40 dark:bg-amber-950/35 dark:text-amber-100 sm:px-6"
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle
          className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-300"
          aria-hidden="true"
        />
        <AlertDescription className="min-w-0 space-y-0.5 text-xs leading-relaxed sm:text-sm">
          <p className="font-medium">{headline}</p>
          <p className="text-amber-900/90 dark:text-amber-200/90">{renewalDate}</p>
        </AlertDescription>
      </div>
    </Alert>
  );
}

/**
 * يجلب اشتراك الشركة الحالي ويعرض الشريط في رأس لوحة الإدارة.
 *
 * `retry: false` keeps a failed read from blocking the layout: the banner is a
 * reminder, so a lookup error hides it rather than showing a broken state.
 */
export function CompanySubscriptionBanner() {
  const fetchBanner = useServerFn(companySubscriptionBanner);
  const { data } = useQuery({
    queryKey: ["company-subscription-banner"],
    queryFn: () => fetchBanner(),
    staleTime: 10 * 60_000,
    retry: false,
  });
  return <SubscriptionBanner subscription={data ?? null} />;
}
