import { useI18n } from "@/i18n/provider";
import { formatAmount, formatKwd } from "@/lib/money";
import type { PlatformOverviewTotals } from "@/platform/overview";

/** ما يعرضه شريط إجماليات المنصة. */
export interface OverviewTotalsProps {
  totals: PlatformOverviewTotals | null;
  loading: boolean;
  error: string | null;
}

/** بطاقة واحدة في شريط الإجماليات. */
interface TotalsCard {
  label: string;
  value: string;
  hint: string | null;
}

/**
 * يبني بطاقات الإجماليات من سطر واحد تقرأه دالة قاعدة البيانات.
 *
 * The active and suspended company counts ride with the total instead of
 * taking a card of their own: they are two readings of the same number, and a
 * card each would make the row of totals longer than the screen is wide.
 */
function overviewCards(
  totals: PlatformOverviewTotals,
  t: (key: string) => string,
  locale: string,
): TotalsCard[] {
  return [
    {
      label: t("platformOverview.totals.companies"),
      value: formatAmount(totals.companies_total, locale),
      hint: `${t("platformOverview.totals.companiesActive")}: ${formatAmount(
        totals.companies_active,
        locale,
      )} · ${t("platformOverview.totals.companiesSuspended")}: ${formatAmount(
        totals.companies_suspended,
        locale,
      )}`,
    },
    {
      label: t("platformOverview.totals.units"),
      value: formatAmount(totals.units_total, locale),
      hint: null,
    },
    {
      label: t("platformOverview.totals.staffUsers"),
      value: formatAmount(totals.staff_users_total, locale),
      hint: null,
    },
    {
      label: t("platformOverview.totals.renters"),
      value: formatAmount(totals.renters_total, locale),
      hint: null,
    },
    {
      label: t("platformOverview.totals.collectedThisMonth"),
      value: formatKwd(totals.collected_this_month, locale),
      hint: null,
    },
  ];
}

/** يعرض إجماليات المنصة: الشركات والوحدات والحسابات والمبلغ المحصّل هذا الشهر. */
export function OverviewTotals({ totals, loading, error }: OverviewTotalsProps) {
  const { t, locale } = useI18n();

  if (loading) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        {t("platformOverview.loading")}
      </p>
    );
  }

  if (error) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {error}
      </p>
    );
  }

  if (!totals) return null;

  const cards = overviewCards(totals, t, locale);

  return (
    <section aria-label={t("platformOverview.totals.title")} className="space-y-3">
      <h2 className="text-sm font-semibold">{t("platformOverview.totals.title")}</h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => (
          <div key={card.label} className="rounded-xl border border-border bg-card p-5">
            <p className="text-sm text-muted-foreground">{card.label}</p>
            <p className="mt-1 text-2xl font-bold tabular-nums">{card.value}</p>
            {card.hint ? <p className="mt-1 text-xs text-muted-foreground">{card.hint}</p> : null}
          </div>
        ))}
      </div>
    </section>
  );
}
