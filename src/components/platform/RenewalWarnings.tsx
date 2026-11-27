import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/i18n/provider";
import { fetchPlatformRenewalWarnings, platformErrorMessage } from "@/platform/platformFns";
import type { RenewalWarning } from "@/platform/subscriptions";

/**
 * قائمة تنبيهات التجديد فوق جدول الشركات: المتأخرة أولاً ثم القريبة من موعدها.
 *
 * The list is read on its own so it never depends on the page's search or
 * pagination: a company on page three can be overdue just as one on page one.
 */
export function RenewalWarnings() {
  const { t, locale } = useI18n();
  const [warnings, setWarnings] = useState<RenewalWarning[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    fetchPlatformRenewalWarnings()
      .then((loaded) => {
        if (mounted) {
          setWarnings(loaded);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (mounted) setError(platformErrorMessage(t, cause));
      });
    return () => {
      mounted = false;
    };
  }, [t]);

  if (error) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {error}
      </p>
    );
  }

  if (warnings.length === 0) return null;

  return (
    <section className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/40 dark:bg-amber-950/20">
      <h2 className="text-sm font-semibold">{t("platformBilling.warnings.title")}</h2>
      <ul className="grid gap-2 text-sm sm:grid-cols-2">
        {warnings.map((warning) => (
          <li key={warning.companyId} className="flex flex-wrap items-center gap-2">
            <Link
              to="/platform/companies/$id"
              params={{ id: warning.companyId }}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {locale === "ar" ? warning.companyNameAr : warning.companyNameEn}
            </Link>
            <span dir="ltr" className="text-xs text-muted-foreground">
              {warning.planName} · {warning.renewalDate}
            </span>
            <Badge variant={warning.daysLeft < 0 ? "warning" : "info"}>
              {warning.daysLeft < 0
                ? t("platformBilling.warnings.overdue")
                : `${t("platformBilling.warnings.daysLeft")} ${warning.daysLeft}`}
            </Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}
