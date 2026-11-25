import { useMemo, useState } from "react";
import {
  Building2,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Filter,
  Grid2X2,
  Layers,
  Plus,
  RefreshCw,
  Sparkles,
} from "lucide-react";

import { TableState } from "@/components/admin/Phase2Ui";
import { FilterSelect } from "@/components/admin/FilterSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useI18n } from "@/i18n/provider";
import { formatAmount } from "@/lib/money";
import { cn } from "@/lib/utils";
import { AnnualKpiRibbon, type MonthSummaryItem } from "./AnnualKpiRibbon";
import { MonthCard } from "./MonthCard";
import { InvoicesThemeSelector } from "./InvoicesThemeSelector";
import type { InvoicesLayoutTheme } from "@/hooks/useInvoicesLayoutTheme";

export type FilterOption = "all" | "current" | "overdue" | "unpaid" | "paid";
export type ViewMode = "grid" | "quarters";

interface MonthlyInvoicesOverviewProps {
  year: number;
  years: number[];
  propertyId: string;
  propertyOptions: Array<{ value: string; label: string }>;
  propertyLabel?: string;
  onSelectProperty: (propertyId: string) => void;
  summaryRows: MonthSummaryItem[];
  isLoading: boolean;
  isError: boolean;
  canCreate: boolean;
  onSelectYear: (year: number) => void;
  onSelectMonth: (month: number) => void;
  onAddYear: (year: number) => Promise<void>;
  isAddYearPending: boolean;
  theme?: InvoicesLayoutTheme;
  onThemeChange?: (theme: InvoicesLayoutTheme) => void;
}

interface QuarterData {
  quarter: 1 | 2 | 3 | 4;
  titleKey: string;
  rangeKey: string;
  months: MonthSummaryItem[];
  total: number;
  paid: number;
  outstanding: number;
  overdue: number;
  count: number;
  collectionRate: number;
}

/**
 * واجهة العرض الشامل للفواتير الشهرية: تجمع شريط المؤشرات السنوية، وأدوات التنقل، وشبكة الشهور وتقسيم الأرباع.
 *
 * Coordinates the entire annual overview experience for property admins,
 * providing real-time filtering, annual KPI metrics, and flexible display modes
 * (standard 12-month bento grid vs quarterly financial rollup).
 */
export function MonthlyInvoicesOverview({
  year,
  years,
  propertyId,
  propertyOptions,
  propertyLabel,
  onSelectProperty,
  summaryRows,
  isLoading,
  isError,
  canCreate,
  onSelectYear,
  onSelectMonth,
  onAddYear,
  isAddYearPending,
  theme,
  onThemeChange,
}: MonthlyInvoicesOverviewProps) {
  const { locale, t } = useI18n();
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [filter, setFilter] = useState<FilterOption>("all");
  const [addYearOpen, setAddYearOpen] = useState(false);
  const [yearDraft, setYearDraft] = useState(String(year));

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  // Filtered month rows based on selected filter pill
  const filteredMonths = useMemo(() => {
    return summaryRows.filter((item) => {
      if (filter === "current") {
        return year === currentYear && item.month === currentMonth;
      }
      if (filter === "overdue") {
        return item.overdue > 0;
      }
      if (filter === "unpaid") {
        return item.count > 0 && item.outstanding > 0;
      }
      if (filter === "paid") {
        return item.count > 0 && item.outstanding === 0;
      }
      return true;
    });
  }, [summaryRows, filter, year, currentYear, currentMonth]);

  // Quarterly aggregated groups for the quarterly view mode
  const quarters = useMemo<QuarterData[]>(() => {
    const definitions: Array<{
      quarter: 1 | 2 | 3 | 4;
      months: number[];
      titleKey: string;
      rangeKey: string;
    }> = [
      {
        quarter: 1,
        months: [1, 2, 3],
        titleKey: "invoices.quarter1",
        rangeKey: "invoices.quarter1Range",
      },
      {
        quarter: 2,
        months: [4, 5, 6],
        titleKey: "invoices.quarter2",
        rangeKey: "invoices.quarter2Range",
      },
      {
        quarter: 3,
        months: [7, 8, 9],
        titleKey: "invoices.quarter3",
        rangeKey: "invoices.quarter3Range",
      },
      {
        quarter: 4,
        months: [10, 11, 12],
        titleKey: "invoices.quarter4",
        rangeKey: "invoices.quarter4Range",
      },
    ];

    return definitions.map((def) => {
      const quarterMonths = summaryRows.filter((row) => def.months.includes(row.month));
      const total = quarterMonths.reduce((sum, row) => sum + row.total, 0);
      const paid = quarterMonths.reduce((sum, row) => sum + row.paid, 0);
      const outstanding = quarterMonths.reduce((sum, row) => sum + row.outstanding, 0);
      const overdue = quarterMonths.reduce((sum, row) => sum + row.overdue, 0);
      const count = quarterMonths.reduce((sum, row) => sum + row.count, 0);
      const collectionRate = total > 0 ? Math.min(100, Math.round((paid / total) * 100)) : 0;

      return {
        quarter: def.quarter,
        titleKey: def.titleKey,
        rangeKey: def.rangeKey,
        months: quarterMonths,
        total,
        paid,
        outstanding,
        overdue,
        count,
        collectionRate,
      };
    });
  }, [summaryRows]);

  const handleAddYearSubmit = async () => {
    const nextYear = Number(yearDraft);
    if (!Number.isInteger(nextYear) || nextYear < 2000 || nextYear > 2200) return;
    await onAddYear(nextYear);
    setAddYearOpen(false);
  };

  const hasOverdueMonths = summaryRows.some((m) => m.overdue > 0);
  const hasUnpaidMonths = summaryRows.some((m) => m.count > 0 && m.outstanding > 0);
  const hasPaidMonths = summaryRows.some((m) => m.count > 0 && m.outstanding === 0);

  return (
    <div className="space-y-6">
      {/* 1. Executive Annual Financial KPI Ribbon */}
      <AnnualKpiRibbon
        summaryRows={summaryRows}
        year={year}
        propertyLabel={propertyLabel}
        locale={locale}
        t={t}
      />

      {/* 2. Controls Toolbar: Year Navigation, View Mode, and Filter Pills */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        {/* Left Side: Year Selector + Quick Prev/Next + Add Year */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Previous Year button */}
          <Button
            variant="outline"
            size="icon"
            className="size-9 rounded-xl"
            title={t("invoices.prevYear")}
            aria-label={t("invoices.prevYear")}
            onClick={() => onSelectYear(year - 1)}
          >
            {locale === "ar" ? (
              <ChevronRight className="size-4" />
            ) : (
              <ChevronLeft className="size-4" />
            )}
          </Button>

          {/* Year Dropdown */}
          <Select value={String(year)} onValueChange={(val) => onSelectYear(Number(val))}>
            <SelectTrigger className="w-36 rounded-xl font-mono font-bold">
              <CalendarDays className="size-4 text-muted-foreground me-1.5" />
              <SelectValue placeholder={t("invoices.selectYear")} />
            </SelectTrigger>
            <SelectContent>
              {years.map((item) => (
                <SelectItem key={item} value={String(item)} className="font-mono font-bold">
                  {item}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Next Year button */}
          <Button
            variant="outline"
            size="icon"
            className="size-9 rounded-xl"
            title={t("invoices.nextYear")}
            aria-label={t("invoices.nextYear")}
            onClick={() => onSelectYear(year + 1)}
          >
            {locale === "ar" ? (
              <ChevronLeft className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
          </Button>

          {/* Add Year Modal Popover */}
          <Popover open={addYearOpen} onOpenChange={setAddYearOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5 rounded-xl text-xs font-semibold"
                disabled={!canCreate}
              >
                <Plus className="size-3.5" />
                {t("invoices.addYear")}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72 space-y-3 rounded-2xl p-4 shadow-xl">
              <div>
                <p className="font-bold text-sm">{t("invoices.addYearTitle")}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {t("invoices.addYearDescription")}
                </p>
              </div>
              <Input
                type="number"
                min={2000}
                max={2200}
                value={yearDraft}
                onChange={(event) => setYearDraft(event.target.value)}
                aria-label={t("invoices.year")}
                className="font-mono font-bold"
              />
              <Button
                className="w-full rounded-xl"
                disabled={isAddYearPending}
                onClick={handleAddYearSubmit}
              >
                {isAddYearPending ? (
                  <RefreshCw className="size-4 animate-spin" />
                ) : (
                  t("invoices.addYear")
                )}
              </Button>
            </PopoverContent>
          </Popover>
          <FilterSelect
            id="invoices-property"
            label={t("filters.property")}
            anyLabel={t("filters.allProperties")}
            value={propertyId}
            options={propertyOptions}
            onChange={onSelectProperty}
            className="w-[16rem] rounded-xl font-semibold"
            icon={<Building2 className="size-4 shrink-0 text-muted-foreground" />}
          />
        </div>

        {/* Right Side: View Mode Toggle, Filter Tabs & Theme Selector */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Theme Selector */}
          {theme && onThemeChange && (
            <InvoicesThemeSelector theme={theme} onChange={onThemeChange} />
          )}

          {/* View Mode Toggle: Grid vs Quarters */}
          <div className="flex items-center rounded-xl bg-muted/60 p-1 ring-1 ring-border/50">
            <button
              type="button"
              onClick={() => setViewMode("grid")}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition",
                viewMode === "grid"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Grid2X2 className="size-3.5" />
              <span>{t("invoices.viewModeGrid")}</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode("quarters")}
              className={cn(
                "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold transition",
                viewMode === "quarters"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Layers className="size-3.5" />
              <span>{t("invoices.viewModeQuarters")}</span>
            </button>
          </div>

          {/* Filter Pills (Shown only in grid mode for precise filtering) */}
          {viewMode === "grid" && (
            <div className="flex items-center gap-1 overflow-x-auto pb-1 lg:pb-0">
              <Button
                variant={filter === "all" ? "default" : "ghost"}
                size="sm"
                className="h-8 rounded-lg text-xs font-semibold px-2.5"
                onClick={() => setFilter("all")}
              >
                {t("invoices.filterAll")}
              </Button>
              {year === currentYear && (
                <Button
                  variant={filter === "current" ? "default" : "ghost"}
                  size="sm"
                  className="h-8 rounded-lg text-xs font-semibold px-2.5"
                  onClick={() => setFilter("current")}
                >
                  {t("invoices.filterCurrent")}
                </Button>
              )}
              {hasOverdueMonths && (
                <Button
                  variant={filter === "overdue" ? "destructive" : "ghost"}
                  size="sm"
                  className="h-8 rounded-lg text-xs font-semibold px-2.5"
                  onClick={() => setFilter("overdue")}
                >
                  {t("invoices.filterOverdue")}
                </Button>
              )}
              {hasUnpaidMonths && (
                <Button
                  variant={filter === "unpaid" ? "secondary" : "ghost"}
                  size="sm"
                  className="h-8 rounded-lg text-xs font-semibold px-2.5"
                  onClick={() => setFilter("unpaid")}
                >
                  {t("invoices.filterUnpaid")}
                </Button>
              )}
              {hasPaidMonths && (
                <Button
                  variant={filter === "paid" ? "outline" : "ghost"}
                  size="sm"
                  className="h-8 rounded-lg text-xs font-semibold px-2.5 text-emerald-700 dark:text-emerald-300"
                  onClick={() => setFilter("paid")}
                >
                  {t("invoices.filterPaid")}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 3. Main Content: 12-Month Bento Grid OR Quarterly Grouping */}
      <TableState loading={isLoading} error={isError} empty={false}>
        {viewMode === "grid" ? (
          filteredMonths.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {filteredMonths.map((item) => (
                <MonthCard
                  key={item.month}
                  item={item}
                  year={year}
                  isCurrentMonth={year === currentYear && item.month === currentMonth}
                  isFutureMonth={
                    year > currentYear || (year === currentYear && item.month > currentMonth)
                  }
                  locale={locale}
                  t={t}
                  onSelect={onSelectMonth}
                />
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-border p-12 text-center">
              <Filter className="mx-auto size-8 text-muted-foreground/60 mb-2" />
              <p className="text-sm font-semibold text-foreground">{t("invoices.noInvoicesYet")}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-4 rounded-xl"
                onClick={() => setFilter("all")}
              >
                {t("invoices.filterAll")}
              </Button>
            </div>
          )
        ) : (
          /* Quarterly Grouped View */
          <div className="space-y-8">
            {quarters.map((q) => (
              <div
                key={q.quarter}
                className="rounded-2xl border bg-muted/20 p-5 shadow-sm space-y-4"
              >
                {/* Quarter Header Summary Bar */}
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-3">
                  <div className="flex items-center gap-2.5">
                    <div className="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary font-bold text-xs font-mono">
                      Q{q.quarter}
                    </div>
                    <div>
                      <h3 className="font-bold text-base text-foreground">{t(q.titleKey)}</h3>
                      <p className="text-xs text-muted-foreground">{t(q.rangeKey)}</p>
                    </div>
                  </div>

                  {/* Quarter Metrics Breakdown */}
                  <div className="flex flex-wrap items-center gap-4 text-xs font-mono">
                    <div className="flex items-center gap-1.5">
                      <span className="text-muted-foreground font-sans">{t("common.total")}:</span>
                      <span className="font-bold text-foreground">
                        {formatAmount(q.total, locale)} {t("invoices.kwdUnit")}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <span className="text-muted-foreground font-sans">{t("invoices.paid")}:</span>
                      <span className="font-bold text-emerald-600 dark:text-emerald-400">
                        {formatAmount(q.paid, locale)} {t("invoices.kwdUnit")}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5">
                      <span className="text-muted-foreground font-sans">
                        {t("invoices.outstanding")}:
                      </span>
                      <span
                        className={cn(
                          "font-bold",
                          q.outstanding > 0
                            ? "text-amber-600 dark:text-amber-400"
                            : "text-muted-foreground",
                        )}
                      >
                        {formatAmount(q.outstanding, locale)} {t("invoices.kwdUnit")}
                      </span>
                    </div>

                    <div className="flex items-center gap-1.5 rounded-lg bg-background px-2.5 py-1 ring-1 ring-border font-bold">
                      <span className="text-muted-foreground font-sans">
                        {t("invoices.collectionRate")}:
                      </span>
                      <span
                        className={cn(
                          q.collectionRate >= 90
                            ? "text-emerald-600"
                            : q.collectionRate >= 60
                              ? "text-teal-600"
                              : "text-amber-600",
                        )}
                      >
                        {q.collectionRate}%
                      </span>
                    </div>
                  </div>
                </div>

                {/* Quarter's 3 Month Cards */}
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {q.months.map((item) => (
                    <MonthCard
                      key={item.month}
                      item={item}
                      year={year}
                      isCurrentMonth={year === currentYear && item.month === currentMonth}
                      isFutureMonth={
                        year > currentYear || (year === currentYear && item.month > currentMonth)
                      }
                      locale={locale}
                      t={t}
                      onSelect={onSelectMonth}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </TableState>
    </div>
  );
}
