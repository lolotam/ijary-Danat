import type { ReactNode } from "react";
import { AlertTriangle, CalendarDays, CreditCard, ShieldCheck } from "lucide-react";

import { VibrantKpiCard } from "@/components/shared/dashboardCards";
import { useCardVisibility } from "@/hooks/useCardVisibility";
import { useI18n } from "@/i18n/provider";
import { formatKwd } from "@/lib/money";

interface PortalKpiCardsProps {
  /** صافي التأمين المحتفظ به لدى المكتب (من usePortalInsurancePaid). */
  insurancePaid: number | null | undefined;
  /** أقرب تاريخ استحقاق قادم، أو null إن لم يوجد. */
  nextDue: string | null | undefined;
  /** عدد الفواتير المتأخرة (من usePortalInvoiceSummary). */
  overdueCount: number | null | undefined;
  /** إجمالي أرصدة الفواتير المتأخرة (من usePortalInvoiceSummary). */
  overdueTotal: number | null | undefined;
}

/**
 * يختار صنف الشبكة بحسب عدد البطاقات الظاهرة لتملأ عرض الصفحة.
 *
 * Full literal class names — Tailwind only generates classes it can see.
 */
export function kpiGridClass(count: number): string {
  switch (count) {
    case 1:
      return "grid gap-5 grid-cols-1";
    case 2:
      return "grid gap-5 grid-cols-1 md:grid-cols-2";
    case 3:
      return "grid gap-5 grid-cols-1 md:grid-cols-3";
    default:
      return "grid gap-5 grid-cols-1 md:grid-cols-2 xl:grid-cols-4";
  }
}

/**
 * بطاقات مؤشرات لوحة البوابة، كل واحدة محجوبة بعلمها الخاص من الإعدادات.
 *
 * Fail closed: while the flag read is pending the skeleton renders, never the
 * cards — an unresolved read must not flash a section the office switched off.
 * The card order below is fixed (insurance → next due → overdue → total) so a
 * tenant toggling flags never sees the same card jump between slots.
 */
export function PortalKpiCards({
  insurancePaid,
  nextDue,
  overdueCount,
  overdueTotal,
}: PortalKpiCardsProps) {
  const { locale, t } = useI18n();
  const flags = useCardVisibility();

  // A failed flag read stays closed but does not spin forever: the cards
  // disappear, like the compose form, instead of a permanent loading state.
  if (flags.error) return null;
  if (!flags.isReady) {
    return (
      <section className={kpiGridClass(4)} role="status" aria-label={t("common.loading")}>
        {[0, 1, 2, 3].map((placeholder) => (
          <div
            key={placeholder}
            className="h-28 animate-pulse rounded-[18px] bg-muted motion-reduce:animate-none"
            aria-hidden="true"
          />
        ))}
      </section>
    );
  }

  // Insurance is money the tenant has handed over and could not see anywhere
  // else in the portal. The owner asked for the KWD total next to the count
  // (2026-09-29); the labels differ ("إجمالي المبالغ المتأخرة" vs the count
  // card's wording) because an older outstanding card, worded like the count,
  // was read as the same figure.
  const cards: ReactNode[] = [];
  if (flags.isCardVisible("portal.insurance")) {
    cards.push(
      <VibrantKpiCard
        key="portal.insurance"
        label={t("portal.dashboard.insurancePaid")}
        value={formatKwd(insurancePaid ?? 0, locale)}
        hint={t("portalHome.insuranceHeldByTheOffice")}
        icon={<ShieldCheck className="size-6 text-white" />}
        bgClass="bg-gradient-to-br from-blue-600 via-blue-600 to-indigo-700 shadow-blue-500/25"
      />,
    );
  }
  if (flags.isCardVisible("portal.nextDue")) {
    cards.push(
      <VibrantKpiCard
        key="portal.nextDue"
        label={t("portal.dashboard.nextDue")}
        value={nextDue ?? "—"}
        hint={t("portalHome.nextUpcomingDueDate")}
        icon={<CalendarDays className="size-6 text-white" />}
        bgClass="bg-gradient-to-br from-emerald-500 via-emerald-600 to-teal-700 shadow-emerald-500/25"
      />,
    );
  }
  if (flags.isCardVisible("portal.overdueInvoices")) {
    cards.push(
      <VibrantKpiCard
        key="portal.overdueInvoices"
        label={t("portal.dashboard.overdueCount")}
        value={String(overdueCount ?? 0)}
        hint={t("portalHome.requiresFollowUp")}
        icon={<AlertTriangle className="size-6 text-white" />}
        bgClass="bg-gradient-to-br from-amber-500 via-amber-600 to-orange-600 shadow-amber-500/25"
      />,
    );
  }
  if (flags.isCardVisible("portal.totalOverdue")) {
    cards.push(
      <VibrantKpiCard
        key="portal.totalOverdue"
        label={t("portal.dashboard.totalOverdue")}
        value={formatKwd(overdueTotal ?? 0, locale)}
        hint={t("portalHome.totalOverdueHint")}
        icon={<CreditCard className="size-6 text-white" />}
        bgClass="bg-gradient-to-br from-rose-500 via-rose-600 to-red-700 shadow-rose-500/25"
      />,
    );
  }

  if (!cards.length) return null;
  return <section className={kpiGridClass(cards.length)}>{cards}</section>;
}
