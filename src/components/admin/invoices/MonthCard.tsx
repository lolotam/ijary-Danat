import { useMemo } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Calendar,
  CheckCircle2,
  Clock,
  Sparkles,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { formatAmount } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { MonthSummaryItem } from "./AnnualKpiRibbon";

interface MonthCardProps {
  item: MonthSummaryItem;
  year: number;
  isCurrentMonth: boolean;
  isFutureMonth: boolean;
  locale: string;
  t: (key: string) => string;
  onSelect: (month: number) => void;
}

/**
 * بطاقة الشهر التفاعلية: تعرض المؤشرات المالية ونسبة التحصيل والحالة لكل شهر.
 *
 * Renders an executive card for an individual month with high-contrast
 * collection efficiency metrics, real-time status badges (current month,
 * overdue warnings, 100% collected), and smooth hover interactions.
 */
export function MonthCard({
  item,
  year,
  isCurrentMonth,
  isFutureMonth,
  locale,
  t,
  onSelect,
}: MonthCardProps) {
  const monthFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === "ar" ? "ar-KW-u-nu-latn" : "en-KW", {
        month: "long",
      }),
    [locale],
  );

  const monthDate = useMemo(() => new Date(year, item.month - 1, 1), [year, item.month]);
  const monthName = monthFormatter.format(monthDate);
  const monthNumber = String(item.month).padStart(2, "0");

  const collectionRate = useMemo(() => {
    if (item.total <= 0) return 0;
    return Math.min(100, Math.round((item.paid / item.total) * 100));
  }, [item.paid, item.total]);

  const isFullyPaid = item.count > 0 && item.outstanding === 0;
  const isEmpty = item.count === 0;
  const hasOverdue = item.overdue > 0;

  // Arrow icon direction per locale
  const ArrowIcon = locale === "ar" ? ArrowLeft : ArrowRight;

  return (
    <button
      type="button"
      onClick={() => onSelect(item.month)}
      className={cn(
        "group relative flex flex-col justify-between overflow-hidden rounded-2xl border text-start transition-all duration-300",
        "bg-card/95 hover:bg-card p-5 hover:shadow-xl hover:-translate-y-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        isCurrentMonth
          ? "border-emerald-500/60 shadow-lg shadow-emerald-500/10 ring-2 ring-emerald-500/30 dark:ring-emerald-400/20 bg-gradient-to-b from-emerald-50/30 to-card dark:from-emerald-950/20"
          : hasOverdue
            ? "border-red-300 dark:border-red-900/60 hover:border-red-400"
            : isFullyPaid
              ? "border-emerald-200 dark:border-emerald-900/50 hover:border-emerald-300"
              : isEmpty
                ? "border-dashed border-border/80 opacity-80 hover:opacity-100 hover:border-solid hover:border-primary/40"
                : "border-border hover:border-primary/40",
      )}
    >
      {/* Top Header: Month title, month number badge, and status pill */}
      <div className="w-full">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <span
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-lg font-mono text-xs font-bold transition",
                isCurrentMonth
                  ? "bg-emerald-600 text-white shadow-sm"
                  : "bg-muted text-muted-foreground group-hover:bg-primary group-hover:text-primary-foreground",
              )}
            >
              {monthNumber}
            </span>
            <div className="min-w-0">
              <h3 className="truncate text-lg font-bold tracking-tight text-foreground group-hover:text-primary transition">
                {monthName}
              </h3>
              <p className="text-[11px] text-muted-foreground font-mono">{year}</p>
            </div>
          </div>

          {/* Contextual Status Badges */}
          <div className="flex flex-wrap items-center justify-end gap-1">
            {isCurrentMonth && (
              <Badge
                variant="outline"
                className="gap-1 border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 text-[11px] font-medium animate-pulse"
              >
                <span className="size-1.5 rounded-full bg-emerald-500" />
                {t("invoices.currentMonthBadge")}
              </Badge>
            )}

            {hasOverdue && (
              <Badge
                variant="destructive"
                className="gap-1 animate-pulse shadow-sm ring-1 ring-red-400/60 text-[11px]"
              >
                <AlertTriangle className="size-3" />
                <span>
                  {item.overdue} {t("invoices.annualOverdue")}
                </span>
              </Badge>
            )}

            {isFullyPaid && !hasOverdue && (
              <Badge
                variant="outline"
                className="gap-1 border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 text-[11px]"
              >
                <CheckCircle2 className="size-3 text-emerald-600 dark:text-emerald-400" />
                <span>{t("invoices.fullyCollected")}</span>
              </Badge>
            )}

            {isEmpty && (
              <Badge variant="secondary" className="text-[11px] text-muted-foreground font-normal">
                {t("invoices.noInvoicesYet")}
              </Badge>
            )}
          </div>
        </div>

        {/* Collection Rate & Progress Bar */}
        {!isEmpty ? (
          <div className="mt-4 rounded-xl bg-muted/40 p-3 ring-1 ring-border/50">
            <div className="flex items-center justify-between text-xs mb-1.5">
              <span className="text-muted-foreground font-medium flex items-center gap-1">
                <Sparkles className="size-3 text-primary/70" />
                {t("invoices.collectionRate")}
              </span>
              <span
                className={cn(
                  "font-mono font-bold text-xs",
                  collectionRate >= 90
                    ? "text-emerald-600 dark:text-emerald-400"
                    : collectionRate >= 60
                      ? "text-teal-600 dark:text-teal-400"
                      : collectionRate >= 30
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-muted-foreground",
                )}
              >
                {collectionRate}%
              </span>
            </div>

            {/* Progress Gauge Track */}
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-500",
                  collectionRate >= 90
                    ? "bg-gradient-to-r from-emerald-500 to-teal-400"
                    : collectionRate >= 60
                      ? "bg-gradient-to-r from-teal-500 to-sky-400"
                      : collectionRate >= 30
                        ? "bg-gradient-to-r from-amber-500 to-yellow-400"
                        : "bg-gradient-to-r from-rose-500 to-orange-400",
                )}
                style={{ width: `${collectionRate}%` }}
              />
            </div>
          </div>
        ) : (
          <div className="mt-4 flex items-center justify-center rounded-xl border border-dashed border-border/80 p-4 text-center">
            <div className="space-y-1">
              <Clock className="mx-auto size-5 text-muted-foreground/60" />
              <p className="text-xs text-muted-foreground font-medium">
                {t("invoices.noInvoicesYet")}
              </p>
            </div>
          </div>
        )}

        {/* Financial Metrics Bento Breakdown */}
        {!isEmpty && (
          <div className="mt-3.5 grid grid-cols-2 gap-2">
            {/* Paid / Collected */}
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-50/40 dark:bg-emerald-950/20 p-2.5">
              <span className="text-[11px] font-medium text-emerald-800 dark:text-emerald-300">
                {t("invoices.paid")}
              </span>
              <div className="mt-1 flex items-baseline gap-1 font-mono">
                <span className="text-base font-bold text-emerald-700 dark:text-emerald-300">
                  {formatAmount(item.paid, locale)}
                </span>
                <span className="text-[10px] text-emerald-600/70 dark:text-emerald-400/70">
                  {t("invoices.kwdUnit")}
                </span>
              </div>
            </div>

            {/* Outstanding Balance */}
            <div
              className={cn(
                "rounded-xl border p-2.5",
                item.outstanding > 0
                  ? "border-amber-500/20 bg-amber-50/40 dark:bg-amber-950/20 text-amber-900 dark:text-amber-200"
                  : "border-border/60 bg-muted/20 text-muted-foreground",
              )}
            >
              <span className="text-[11px] font-medium">{t("invoices.outstanding")}</span>
              <div className="mt-1 flex items-baseline gap-1 font-mono">
                <span
                  className={cn(
                    "text-base font-bold",
                    item.outstanding > 0
                      ? "text-amber-700 dark:text-amber-300"
                      : "text-muted-foreground",
                  )}
                >
                  {formatAmount(item.outstanding, locale)}
                </span>
                <span className="text-[10px] text-muted-foreground/70">
                  {t("invoices.kwdUnit")}
                </span>
              </div>
            </div>

            {/* Total Invoiced & Invoice Count */}
            <div className="col-span-2 flex items-center justify-between rounded-xl bg-muted/30 px-3 py-2 text-xs">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Calendar className="size-3.5" />
                <span>{t("common.total")}:</span>
                <span className="font-mono font-bold text-foreground">
                  {formatAmount(item.total, locale)} {t("invoices.kwdUnit")}
                </span>
              </div>
              <span className="rounded-md bg-background px-2 py-0.5 font-mono text-[11px] font-semibold text-muted-foreground ring-1 ring-border">
                {item.count} {t("invoices.count")}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Interactive Bottom Footer Cue */}
      <div className="mt-4 flex items-center justify-between border-t border-border/50 pt-3 text-xs font-semibold text-primary transition">
        <span>{t("invoices.viewMonthInvoices")}</span>
        <div className="flex size-6 items-center justify-center rounded-full bg-primary/10 transition-transform duration-300 group-hover:translate-x-1 rtl:group-hover:-translate-x-1 group-hover:bg-primary group-hover:text-primary-foreground">
          <ArrowIcon className="size-3.5" />
        </div>
      </div>
    </button>
  );
}
