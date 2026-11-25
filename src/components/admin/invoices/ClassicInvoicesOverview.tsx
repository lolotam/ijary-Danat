import { useMemo, useState } from "react";
import { Building2, Plus, RefreshCw } from "lucide-react";

import { TableState } from "@/components/admin/Phase2Ui";
import { FilterSelect } from "@/components/admin/FilterSelect";
import { Badge } from "@/components/ui/badge";
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
import type { MonthSummaryItem } from "./AnnualKpiRibbon";
import { InvoicesThemeSelector } from "./InvoicesThemeSelector";
import type { InvoicesLayoutTheme } from "@/hooks/useInvoicesLayoutTheme";

interface ClassicInvoicesOverviewProps {
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
  theme: InvoicesLayoutTheme;
  onThemeChange: (theme: InvoicesLayoutTheme) => void;
}

/**
 * العرض الكلاسيكي الأصلي للفواتير الشهرية: شبكة مبسطة للشهور الـ 12 مع شريط التبديل.
 *
 * Renders the original classic minimalist view with the 12 month cards and
 * clean basic stats, preserving full backwards compatibility.
 */
export function ClassicInvoicesOverview({
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
}: ClassicInvoicesOverviewProps) {
  const { locale, t } = useI18n();
  const [addYearOpen, setAddYearOpen] = useState(false);
  const [yearDraft, setYearDraft] = useState(String(year));

  const monthFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === "ar" ? "ar-KW-u-nu-latn" : "en-KW", {
        month: "long",
      }),
    [locale],
  );

  const handleAddYearSubmit = async () => {
    const nextYear = Number(yearDraft);
    if (!Number.isInteger(nextYear) || nextYear < 2000 || nextYear > 2200) return;
    await onAddYear(nextYear);
    setAddYearOpen(false);
  };

  return (
    <div className="space-y-6">
      {/* Top Toolbar: Year Picker, Add Year, and Theme Selector */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Select value={String(year)} onValueChange={(value) => onSelectYear(Number(value))}>
            <SelectTrigger className="w-40 rounded-xl">
              <SelectValue placeholder={t("invoices.selectYear")} />
            </SelectTrigger>
            <SelectContent>
              {years.map((item) => (
                <SelectItem key={item} value={String(item)}>
                  {item}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {propertyLabel && (
            <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-mono">
              {propertyLabel}
            </span>
          )}

          <Popover open={addYearOpen} onOpenChange={setAddYearOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" disabled={!canCreate}>
                <Plus className="size-4" />
                {t("invoices.addYear")}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72 space-y-3">
              <div>
                <p className="font-semibold">{t("invoices.addYearTitle")}</p>
                <p className="text-sm text-muted-foreground">{t("invoices.addYearDescription")}</p>
              </div>
              <Input
                type="number"
                min={2000}
                max={2200}
                value={yearDraft}
                onChange={(event) => setYearDraft(event.target.value)}
                aria-label={t("invoices.year")}
              />
              <Button className="w-full" disabled={isAddYearPending} onClick={handleAddYearSubmit}>
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

        {/* Theme Selector on Classic View */}
        <InvoicesThemeSelector theme={theme} onChange={onThemeChange} />
      </div>

      {/* Classic 12 Month Cards Grid */}
      <TableState loading={isLoading} error={isError} empty={false}>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {summaryRows.map((item) => (
            <button
              key={item.month}
              type="button"
              onClick={() => onSelectMonth(item.month)}
              className="rounded-xl border bg-card p-4 text-start transition hover:border-primary/50 hover:shadow-md"
            >
              <div className="flex items-center justify-between">
                <span className="text-lg font-bold">
                  {monthFormatter.format(new Date(year, item.month - 1, 1))}
                </span>
                {item.overdue > 0 && (
                  <Badge variant="destructive" className="animate-pulse ring-2 ring-red-400/60">
                    {item.overdue}
                  </Badge>
                )}
              </div>
              <div className="mt-4 grid grid-cols-2 gap-2 text-sm text-muted-foreground">
                <span>
                  {t("invoices.count")}: {item.count}
                </span>
                <span>
                  {t("common.total")}: {formatAmount(item.total, locale)}
                </span>
                <span className="text-emerald-700 dark:text-emerald-400">
                  {t("invoices.paid")}: {formatAmount(item.paid, locale)}
                </span>
                <span className="text-amber-700 dark:text-amber-400">
                  {t("invoices.outstanding")}: {formatAmount(item.outstanding, locale)}
                </span>
              </div>
            </button>
          ))}
        </div>
      </TableState>
    </div>
  );
}
