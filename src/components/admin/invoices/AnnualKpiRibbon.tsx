import { useMemo } from "react";
import {
  AlertCircle,
  ArrowUpRight,
  BadgeCheck,
  CalendarCheck2,
  Coins,
  Receipt,
  TrendingUp,
  Wallet,
} from "lucide-react";

import { formatAmount } from "@/lib/money";
import { cn } from "@/lib/utils";

export type { MonthSummaryItem } from "@/hooks/useInvoices";
import type { MonthSummaryItem } from "@/hooks/useInvoices";

interface AnnualKpiRibbonProps {
  summaryRows: MonthSummaryItem[];
  year: number;
  propertyLabel?: string;
  locale: string;
  t: (key: string) => string;
}

/**
 * شريط الأداء المالي السنوي: يلخّص إجمالي الفواتير والتحصيل والمتأخرات ومعدل الكفاءة لعام كامل.
 *
 * Provides an executive-level rollup of the active year's invoice operations,
 * giving property admins instantaneous visibility into annual revenue, actual
 * cash collection rate, pending balances, and overdue accounts.
 */
export function AnnualKpiRibbon({
  summaryRows,
  year,
  propertyLabel,
  locale,
  t,
}: AnnualKpiRibbonProps) {
  const totals = useMemo(() => {
    const annualTotal = summaryRows.reduce((sum, item) => sum + item.total, 0);
    const annualPaid = summaryRows.reduce((sum, item) => sum + item.paid, 0);
    const annualOutstanding = summaryRows.reduce((sum, item) => sum + item.outstanding, 0);
    const annualCount = summaryRows.reduce((sum, item) => sum + item.count, 0);
    const annualOverdue = summaryRows.reduce((sum, item) => sum + item.overdue, 0);
    const collectionRate =
      annualTotal > 0 ? Math.min(100, Math.round((annualPaid / annualTotal) * 100)) : 0;

    return {
      annualTotal,
      annualPaid,
      annualOutstanding,
      annualCount,
      annualOverdue,
      collectionRate,
    };
  }, [summaryRows]);

  return (
    <div className="relative overflow-hidden rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-slate-900 via-slate-900/95 to-emerald-950 p-5 sm:p-6 text-white shadow-xl">
      {/* Decorative ambient lighting */}
      <div
        className="pointer-events-none absolute -end-16 -top-16 size-56 rounded-full bg-emerald-500/15 blur-3xl"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute -bottom-16 -start-16 size-48 rounded-full bg-amber-500/10 blur-3xl"
        aria-hidden="true"
      />

      {/* Top Header info */}
      <div className="relative z-10 mb-5 flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-4">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-white/10 text-emerald-400 backdrop-blur-md ring-1 ring-white/15">
            <TrendingUp className="size-5" />
          </div>
          <div>
            <h2 className="text-base sm:text-lg font-bold tracking-tight text-white flex items-center gap-2">
              <span>{t("invoices.annualOverview")}</span>
              <span className="rounded-md bg-emerald-500/20 px-2 py-0.5 text-xs font-mono font-semibold text-emerald-300 ring-1 ring-emerald-500/30">
                {year}
              </span>
              {propertyLabel && (
                <span className="rounded-md bg-emerald-500/20 px-2 py-0.5 text-xs font-mono font-semibold text-emerald-300 ring-1 ring-emerald-500/30">
                  {propertyLabel}
                </span>
              )}
            </h2>
            <p className="text-xs text-slate-300/80">
              {t("invoices.invoicesCountBadge").replace("{count}", String(totals.annualCount))}
            </p>
          </div>
        </div>

        {/* Overdue alert pill if any overdue invoices exist in the year */}
        {totals.annualOverdue > 0 ? (
          <div className="flex items-center gap-2 rounded-full border border-red-500/30 bg-red-500/20 px-3 py-1 text-xs font-medium text-red-200 backdrop-blur-md animate-pulse">
            <AlertCircle className="size-3.5 text-red-400" />
            <span>
              {totals.annualOverdue} {t("invoices.annualOverdue")}
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300 backdrop-blur-md">
            <BadgeCheck className="size-3.5 text-emerald-400" />
            <span>{t("invoices.fullyCollected")}</span>
          </div>
        )}
      </div>

      {/* 4-Metric Grid */}
      <div className="relative z-10 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/* Metric 1: Annual Total Invoiced */}
        <div className="rounded-xl border border-white/10 bg-white/5 p-4 backdrop-blur-md transition hover:bg-white/10">
          <div className="flex items-center justify-between text-xs text-slate-300">
            <span>{t("invoices.annualTotal")}</span>
            <Receipt className="size-4 text-sky-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-2xl sm:text-3xl font-black font-mono tracking-tight text-white">
              {formatAmount(totals.annualTotal, locale)}
            </span>
            <span className="text-xs font-medium text-slate-400">{t("invoices.kwdUnit")}</span>
          </div>
          <div className="mt-2.5 flex items-center gap-1.5 text-xs text-slate-300/80">
            <span className="inline-block size-1.5 rounded-full bg-sky-400" />
            <span>
              {totals.annualCount} {t("invoices.count")}
            </span>
          </div>
        </div>

        {/* Metric 2: Collected (Paid) */}
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-950/30 p-4 backdrop-blur-md transition hover:bg-emerald-950/50">
          <div className="flex items-center justify-between text-xs text-emerald-200">
            <span>{t("invoices.annualPaid")}</span>
            <Wallet className="size-4 text-emerald-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-2xl sm:text-3xl font-black font-mono tracking-tight text-emerald-300">
              {formatAmount(totals.annualPaid, locale)}
            </span>
            <span className="text-xs font-medium text-emerald-400/80">{t("invoices.kwdUnit")}</span>
          </div>
          {/* Visual Mini Progress Bar */}
          <div className="mt-2.5 space-y-1">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-emerald-950/80">
              <div
                className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-400 transition-all duration-500"
                style={{ width: `${totals.collectionRate}%` }}
              />
            </div>
          </div>
        </div>

        {/* Metric 3: Outstanding Balance */}
        <div className="rounded-xl border border-amber-500/20 bg-amber-950/20 p-4 backdrop-blur-md transition hover:bg-amber-950/40">
          <div className="flex items-center justify-between text-xs text-amber-200">
            <span>{t("invoices.annualOutstanding")}</span>
            <Coins className="size-4 text-amber-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-1.5">
            <span className="text-2xl sm:text-3xl font-black font-mono tracking-tight text-amber-300">
              {formatAmount(totals.annualOutstanding, locale)}
            </span>
            <span className="text-xs font-medium text-amber-400/80">{t("invoices.kwdUnit")}</span>
          </div>
          <div className="mt-2.5 flex items-center gap-1.5 text-xs text-amber-300/80">
            <span className="inline-block size-1.5 rounded-full bg-amber-400" />
            <span>
              {totals.annualTotal > 0
                ? `${Math.round((totals.annualOutstanding / totals.annualTotal) * 100)}% ${t("invoices.outstanding")}`
                : "—"}
            </span>
          </div>
        </div>

        {/* Metric 4: Collection Rate Efficiency */}
        <div className="rounded-xl border border-white/10 bg-white/5 p-4 backdrop-blur-md transition hover:bg-white/10 flex flex-col justify-between">
          <div className="flex items-center justify-between text-xs text-slate-300">
            <span>{t("invoices.annualCollectionRate")}</span>
            <ArrowUpRight className="size-4 text-emerald-400" />
          </div>
          <div className="my-1 flex items-center justify-between gap-3">
            <div>
              <span
                className={cn(
                  "text-3xl sm:text-4xl font-black font-mono tracking-tight",
                  totals.collectionRate >= 90
                    ? "text-emerald-300"
                    : totals.collectionRate >= 60
                      ? "text-teal-300"
                      : totals.collectionRate >= 30
                        ? "text-amber-300"
                        : "text-slate-300",
                )}
              >
                {totals.collectionRate}%
              </span>
              <p className="text-[11px] text-slate-400">{t("invoices.collectionRate")}</p>
            </div>

            {/* Circular Rate Indicator SVG */}
            <div className="relative size-12 shrink-0">
              <svg className="size-full -rotate-90" viewBox="0 0 36 36">
                <circle
                  cx="18"
                  cy="18"
                  r="15.5"
                  className="stroke-white/10 fill-none"
                  strokeWidth="3"
                />
                <circle
                  cx="18"
                  cy="18"
                  r="15.5"
                  className={cn(
                    "fill-none transition-all duration-700",
                    totals.collectionRate >= 90
                      ? "stroke-emerald-400"
                      : totals.collectionRate >= 60
                        ? "stroke-teal-400"
                        : totals.collectionRate >= 30
                          ? "stroke-amber-400"
                          : "stroke-slate-500",
                  )}
                  strokeWidth="3"
                  strokeDasharray={`${(totals.collectionRate / 100) * 97.4} 97.4`}
                  strokeLinecap="round"
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <CalendarCheck2 className="size-4 text-emerald-400/80" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
