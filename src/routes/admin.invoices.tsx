import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, CalendarClock, FileSearch, PlayCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { InvoicesTable } from "@/components/admin/invoices/InvoicesTable";
import { ClassicInvoicesOverview } from "@/components/admin/invoices/ClassicInvoicesOverview";
import { MonthlyInvoicesOverview } from "@/components/admin/invoices/MonthlyInvoicesOverview";
import { ModuleHeader, Pager, SelectFilter, TableState } from "@/components/admin/Phase2Ui";
import { TenantOptionLabel } from "@/components/admin/TenantOptionLabel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Toaster } from "@/components/ui/sonner";
import { useIsMobile } from "@/hooks/use-mobile";
import { useMaxContractEndYear } from "@/hooks/useContracts";
import { useDebounce } from "@/hooks/useDebounce";
import { useEvaluateOverdue } from "@/hooks/useEvaluateOverdue";
import { useGenerateInvoices } from "@/hooks/useGenerateInvoices";
import {
  useAddInvoiceYear,
  useInvoiceYears,
  useInvoices,
  useMonthlyInvoiceSummary,
} from "@/hooks/useInvoices";
import { useInvoicesLayoutTheme } from "@/hooks/useInvoicesLayoutTheme";
import { usePermissions } from "@/hooks/usePermissions";
import { useProperties } from "@/hooks/useProperties";
import { useTenants } from "@/hooks/useTenants";
import { useUnits } from "@/hooks/useUnits";
import { useI18n } from "@/i18n/provider";
import type { InvoiceState } from "@/integrations/supabase/database.types";
import { formatAmount } from "@/lib/money";
import { PERMISSIONS } from "@/lib/permissions";
import { propertyFilterOptions } from "@/lib/propertyDisplayName";
import { isContractEnded, tenantDisplayName } from "@/lib/tenantDisplayName";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const Route = createFileRoute("/admin/invoices")({
  component: InvoicesPage,
  /** يستبعد معرّفات المباني المشوّهة قبل وصولها إلى استعلامات الفواتير. */
  validateSearch: (
    search: Record<string, unknown>,
  ): { year?: number; month?: number; property?: string } => {
    const year = Number(search.year);
    const month = Number(search.month);
    return {
      year: Number.isInteger(year) && year >= 2000 && year <= 2200 ? year : undefined,
      month: Number.isInteger(month) && month >= 1 && month <= 12 ? month : undefined,
      property:
        typeof search.property === "string" && UUID.test(search.property)
          ? search.property
          : undefined,
    };
  },
});

const invoiceStates: InvoiceState[] = [
  "due",
  "overdue",
  "paid",
  "partially_paid",
  "cancelled",
  "waived",
];

/**
 * سنوات متتالية من `from` حتى `to` شاملة، وسنة واحدة إن كانت `to` أقدم.
 *
 * Guards the descending case rather than returning an empty list: an empty
 * year list would render a target-year selector with nothing in it, which
 * disables the Generate action instead of merely defaulting it.
 */
function rangeOfYears(from: number, to: number): number[] {
  if (to < from) return [from];
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

function InvoicesPage() {
  const { locale, t } = useI18n();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const permissions = usePermissions();
  const isMobile = useIsMobile();
  const { layoutTheme, setLayoutTheme } = useInvoicesLayoutTheme();
  const now = new Date();
  const year = search.year ?? now.getFullYear();
  const month = search.month;
  const [state, setState] = useState<InvoiceState | undefined>();
  /** Opt-in disputed filter: "all" | "disputed". Never hides archived-contract invoices. */
  const [disputedFilter, setDisputedFilter] = useState<"all" | "disputed">("all");
  const [tenantId, setTenantId] = useState("all");
  const propertyId = search.property;
  const [unitId, setUnitId] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");
  const debouncedSearch = useDebounce(searchTerm);
  const [page, setPage] = useState(1);
  const [generateOpen, setGenerateOpen] = useState(false);
  /** `null` = follow the default below; a number = the admin picked a year. */
  const [generateYearDraft, setGenerateYearDraft] = useState<number | null>(null);
  const pageSize = 10;
  const canRead = permissions.can(PERMISSIONS.INVOICES_READ);
  const summary = useMonthlyInvoiceSummary(year, propertyId ?? null, canRead);
  const years = useInvoiceYears(canRead);
  const addYear = useAddInvoiceYear();
  const canGenerate = permissions.can(PERMISSIONS.INVOICES_CREATE);
  const maxContractEndYear = useMaxContractEndYear(canRead && canGenerate);
  const defaultThroughYear = maxContractEndYear.data ?? now.getFullYear();
  const generateThroughYear = generateYearDraft ?? defaultThroughYear;
  const generateYearOptions = [
    ...new Set([year, ...rangeOfYears(now.getFullYear(), defaultThroughYear)]),
  ].sort((a, b) => a - b);
  const invoices = useInvoices(
    {
      page,
      pageSize,
      periodYear: year,
      periodMonth: month,
      search: debouncedSearch,
      state,
      disputed: disputedFilter === "disputed" ? true : undefined,
      tenantId: tenantId === "all" ? undefined : tenantId,
      propertyId,
      unitId: unitId === "all" ? undefined : unitId,
    },
    canRead && Boolean(month),
  );
  const filterTenants = useTenants(
    { pageSize: 500 },
    canRead && Boolean(month) && permissions.can(PERMISSIONS.TENANTS_READ),
  );
  const filterProperties = useProperties(
    { pageSize: 100 },
    canRead && permissions.can(PERMISSIONS.PROPERTIES_READ),
  );
  const propertyOptions = propertyFilterOptions(filterProperties.data?.items ?? [], locale);
  const propertyLabel = propertyId
    ? (propertyOptions.find((option) => option.value === propertyId)?.label ??
      propertyId.slice(0, 8))
    : undefined;
  const filterUnits = useUnits(
    { pageSize: 500, propertyId },
    canRead && Boolean(month) && permissions.can(PERMISSIONS.UNITS_READ),
  );
  const generate = useGenerateInvoices();
  const evaluate = useEvaluateOverdue();
  const monthFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale === "ar" ? "ar-KW-u-nu-latn" : "en-KW", { month: "long" }),
    [locale],
  );
  const summaryRows = summary.data ?? [];
  const monthSummary = month ? summaryRows.find((item) => item.month === month) : undefined;

  /** يمنع بقاء صفحة أو وحدة من المبنى السابق، حتى عند الرجوع عبر المتصفح. */
  useEffect(() => {
    setPage(1);
    setUnitId("all");
  }, [propertyId]);

  if (!canRead)
    return (
      <p className="rounded-lg border p-6 text-sm text-destructive">{t("common.forbidden")}</p>
    );

  /** يحتفظ بنطاق المبنى عند الانتقال إلى سنة أخرى. */
  const goToYear = (nextYear: number) => {
    navigate({
      to: "/admin/invoices",
      search: { year: nextYear, ...(propertyId ? { property: propertyId } : {}) },
    });
  };
  /** يفتح تفاصيل الشهر ضمن المبنى المختار ويصفّر مرشحات التفاصيل السابقة. */
  const goToMonth = (nextMonth: number) => {
    setState(undefined);
    setTenantId("all");
    setUnitId("all");
    setSearchTerm("");
    setPage(1);
    navigate({
      to: "/admin/invoices",
      search: { year, month: nextMonth, ...(propertyId ? { property: propertyId } : {}) },
    });
  };
  /** يعيد ملخص السنة مع إبقاء نطاق المبنى مطابقاً لتفاصيل الشهر. */
  const backToMonths = () => {
    navigate({
      to: "/admin/invoices",
      search: { year, ...(propertyId ? { property: propertyId } : {}) },
    });
  };

  /** يحفظ المبنى في العنوان؛ الفراغ و"all" يحذفان التصفية لاختلاف اصطلاح القائمتين. */
  const setProperty = (id: string) =>
    navigate({
      to: "/admin/invoices",
      search: {
        year,
        ...(month ? { month } : {}),
        ...(id && id !== "all" ? { property: id } : {}),
      },
    });

  const runAddYear = async (value: number) => {
    if (!Number.isInteger(value) || value < 2000 || value > 2200) {
      toast.error(t("common.error"));
      return;
    }
    try {
      await addYear.mutateAsync(value);
      toast.success(t("invoices.yearAdded").replace("{year}", String(value)));
      goToYear(value);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  };

  /**
   * يولّد الفواتير الشهرية الناقصة حتى نهاية السنة الهدف، لا حتى نهاية السنة
   * المعروضة على الشاشة.
   *
   * Binding the target to the *viewed* year hid a 17-month contract's second
   * year: the page opens on the current year, every period of it already
   * existed, and the generator answered "0 generated" with no error.
   */
  const runGenerate = async () => {
    try {
      const rows = await generate.mutateAsync({ throughYear: generateThroughYear });
      toast.success(t("invoices.generated").replace("{count}", String(rows.length)));
      setGenerateOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  };

  const runEvaluate = async () => {
    try {
      const rows = await evaluate.mutateAsync({});
      toast.success(t("invoices.evaluated").replace("{count}", String(rows.length)));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  };

  const headerActions = (
    <>
      <Button
        variant="outline"
        disabled={!permissions.can(PERMISSIONS.INVOICES_UPDATE) || evaluate.isPending}
        onClick={() => void runEvaluate()}
      >
        <CalendarClock className="size-4" />
        {t("invoices.evaluateOverdue")}
      </Button>
      <Button disabled={!canGenerate} onClick={() => setGenerateOpen(true)}>
        <PlayCircle className="size-4" />
        {t("invoices.generate")}
      </Button>
    </>
  );

  return (
    <div className="space-y-6">
      <Toaster richColors position="top-center" />
      <ModuleHeader
        title={t("invoices.title")}
        subtitle={t("invoices.subtitle")}
        actions={headerActions}
      />

      {month == null ? (
        layoutTheme === "classic" ? (
          <ClassicInvoicesOverview
            year={year}
            propertyId={propertyId ?? ""}
            propertyOptions={propertyOptions}
            propertyLabel={propertyLabel}
            onSelectProperty={setProperty}
            years={years.data ?? [year]}
            summaryRows={summaryRows}
            isLoading={summary.isLoading}
            isError={summary.isError}
            canCreate={permissions.can(PERMISSIONS.INVOICES_CREATE)}
            onSelectYear={goToYear}
            onSelectMonth={goToMonth}
            onAddYear={runAddYear}
            isAddYearPending={addYear.isPending}
            theme={layoutTheme}
            onThemeChange={setLayoutTheme}
          />
        ) : (
          <MonthlyInvoicesOverview
            year={year}
            propertyId={propertyId ?? ""}
            propertyOptions={propertyOptions}
            propertyLabel={propertyLabel}
            onSelectProperty={setProperty}
            years={years.data ?? [year]}
            summaryRows={summaryRows}
            isLoading={summary.isLoading}
            isError={summary.isError}
            canCreate={permissions.can(PERMISSIONS.INVOICES_CREATE)}
            onSelectYear={goToYear}
            onSelectMonth={goToMonth}
            onAddYear={runAddYear}
            isAddYearPending={addYear.isPending}
            theme={layoutTheme}
            onThemeChange={setLayoutTheme}
          />
        )
      ) : (
        <>
          <div className="overflow-hidden rounded-2xl bg-gradient-to-br from-emerald-700 via-emerald-800 to-emerald-950 p-6 text-white shadow-lg">
            <Button
              variant="ghost"
              className="mb-4 h-8 gap-1 px-2 text-white hover:bg-white/15 hover:text-white"
              onClick={backToMonths}
            >
              <ArrowLeft className="size-4 rtl:rotate-180" />
              {t("invoices.backToMonths")}
            </Button>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 className="text-3xl font-black tracking-tight sm:text-4xl">
                  {monthFormatter.format(new Date(year, month - 1, 1))}
                </h2>
                <p className="text-sm text-white/70">{year}</p>
              </div>
              <div className="grid grid-cols-3 gap-3 text-center sm:gap-6">
                <div>
                  <div className="text-2xl font-black sm:text-3xl">{monthSummary?.count ?? 0}</div>
                  <div className="text-sm text-white/70">{t("invoices.monthInvoices")}</div>
                </div>
                <div>
                  <div className="text-2xl font-black text-amber-300 sm:text-3xl">
                    {formatAmount(monthSummary?.outstanding ?? 0, locale)}
                  </div>
                  <div className="text-sm text-white/70">{t("invoices.outstanding")}</div>
                </div>
                <div>
                  <div className="text-2xl font-black text-emerald-300 sm:text-3xl">
                    {formatAmount(monthSummary?.paid ?? 0, locale)}
                  </div>
                  <div className="text-sm text-white/70">{t("invoices.paid")}</div>
                </div>
              </div>
            </div>
          </div>

          <Card>
            <CardHeader className="gap-4">
              <CardTitle className="flex items-center gap-2">
                <FileSearch className="size-5" />
                {monthFormatter.format(new Date(year, month - 1, 1))} {year}
              </CardTitle>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <Select
                  value={state ?? "all"}
                  onValueChange={(value) => {
                    setState(value === "all" ? undefined : (value as InvoiceState));
                    setPage(1);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("invoices.state")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("common.all")}</SelectItem>
                    {invoiceStates.map((item) => (
                      <SelectItem key={item} value={item}>
                        {t(`invoiceState.${item}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={disputedFilter}
                  onValueChange={(value) => {
                    setDisputedFilter(value as "all" | "disputed");
                    setPage(1);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("invoice.disputedFilter")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("invoice.disputedAll")}</SelectItem>
                    <SelectItem value="disputed">{t("invoice.disputedOnly")}</SelectItem>
                  </SelectContent>
                </Select>
                <SelectFilter
                  value={tenantId}
                  onChange={(value) => {
                    setTenantId(value);
                    setPage(1);
                  }}
                  label={t("contracts.tenant")}
                  options={(filterTenants.data?.items ?? []).map((tenant, index) => ({
                    value: tenant.id,
                    label: (
                      <TenantOptionLabel index={index} ended={isContractEnded(tenant)}>
                        {tenantDisplayName(tenant, locale)}
                      </TenantOptionLabel>
                    ),
                  }))}
                />
                <SelectFilter
                  value={propertyId ?? "all"}
                  onChange={setProperty}
                  label={t("invoices.complex")}
                  options={propertyOptions}
                />
                <SelectFilter
                  value={unitId}
                  onChange={(value) => {
                    setUnitId(value);
                    setPage(1);
                  }}
                  label={t("contracts.unit")}
                  options={(filterUnits.data?.items ?? []).map((unit) => ({
                    value: unit.id,
                    label: unit.name,
                  }))}
                />
                <Input
                  value={searchTerm}
                  onChange={(event) => {
                    // Reset on the keystroke: the query still holds the settled
                    // term, so page 1 of it is the only request that fires.
                    setSearchTerm(event.target.value);
                    setPage(1);
                  }}
                  placeholder={t("invoices.search")}
                />
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <TableState
                loading={invoices.isLoading}
                error={invoices.isError}
                empty={!invoices.data?.items.length}
              >
                <InvoicesTable
                  invoices={invoices.data?.items ?? []}
                  page={page}
                  pageSize={pageSize}
                  canUpdate={permissions.can(PERMISSIONS.INVOICES_UPDATE)}
                  canCreatePayment={permissions.can(PERMISSIONS.PAYMENTS_CREATE)}
                  isMobile={isMobile}
                />
              </TableState>
              <Pager
                page={page}
                pageSize={pageSize}
                count={invoices.data?.count ?? 0}
                setPage={setPage}
              />
            </CardContent>
          </Card>
        </>
      )}

      <AlertDialog
        open={generateOpen}
        onOpenChange={(open) => {
          setGenerateOpen(open);
          if (open) setGenerateYearDraft(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("invoices.generateTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("invoices.generateDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="generate-through-year">{t("invoices.generateThroughYear")}</Label>
            <Select
              value={String(generateThroughYear)}
              onValueChange={(value) => setGenerateYearDraft(Number(value))}
            >
              <SelectTrigger id="generate-through-year" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {generateYearOptions.map((item) => (
                  <SelectItem key={item} value={String(item)}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {t("invoices.generateThroughYearHint").replace("{year}", String(generateThroughYear))}
            </p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction disabled={generate.isPending} onClick={() => void runGenerate()}>
              {generate.isPending ? (
                <RefreshCw className="size-4 animate-spin" />
              ) : (
                t("common.confirm")
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
