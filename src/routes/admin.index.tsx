import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import { useInvoices, useInvoiceYears } from "@/hooks/useInvoices";
import { usePermissions } from "@/hooks/usePermissions";
import { useI18n } from "@/i18n/provider";
import { formatIsoDateForDisplay } from "@/lib/dateDisplay";
import { formatKwd } from "@/lib/money";
import { useDashboardKpis } from "@/hooks/useDashboardKpis";
import { PERMISSIONS } from "@/lib/permissions";
import { tenantDisplayName } from "@/lib/tenantDisplayName";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DashboardKpiCards } from "@/components/admin/ownedPageKpis";
import { InvoiceStatusBadge, PaymentStatusBadge } from "@/components/shared/dashboardCards";
import { useCardVisibility } from "@/hooks/useCardVisibility";

function formatDate(value: string | null | undefined, dir: "ltr" | "rtl") {
  if (!value) return "—";
  return formatIsoDateForDisplay(value, dir) || "—";
}

export const Route = createFileRoute("/admin/")({
  component: AdminDashboard,
});

function useRecentPayments() {
  return useQuery({
    queryKey: ["admin", "dashboard", "recentPayments"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments")
        .select("id, code, amount, method, payment_date, tenant_id, tenants(name, name_en)")
        .eq("status", "confirmed")
        .order("payment_date", { ascending: false })
        .limit(6);
      if (error) throw error;
      return data ?? [];
    },
    staleTime: 30_000,
  });
}

function AdminDashboard() {
  const { t, locale, dir } = useI18n();
  const permissions = usePermissions();
  const kpis = useDashboardKpis();
  const { isCardVisible } = useCardVisibility();

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  // The invoices card is filtered by billing period (year + month) rather than
  // showing an arbitrary slice of the most recently created rows, which mixed
  // different months together. Defaults to the current month.
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [selectedMonth, setSelectedMonth] = useState(currentMonth);

  const canReadInvoices = permissions.can(PERMISSIONS.INVOICES_READ);
  const invoiceYears = useInvoiceYears(canReadInvoices);
  const invoices = useInvoices(
    { pageSize: 100, periodYear: selectedYear, periodMonth: selectedMonth },
    canReadInvoices,
  );
  const payments = useRecentPayments();

  const cur = (v: number) => formatKwd(v, locale);
  const k = kpis.data;

  const yearOptions = invoiceYears.data ?? [currentYear];
  const monthOptions = useMemo(() => {
    const monthFormatter = new Intl.DateTimeFormat(locale === "ar" ? "ar-KW-u-nu-latn" : "en-KW", {
      month: "long",
    });
    return Array.from({ length: 12 }, (_, index) => ({
      value: index + 1,
      label: monthFormatter.format(new Date(2000, index, 1)),
    }));
  }, [locale]);

  return (
    <div className="space-y-8 pb-10">
      <div>
        <h1 className="text-3xl font-extrabold tracking-tight">{t("admin.dashboard")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("adminDashboard.liveOverviewOfKeyMetrics")}
        </p>
      </div>

      {kpis.isError && (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive font-medium shadow-sm">
          {t("common.error")}
        </div>
      )}

      {/* All nine KPI cards share one grid so they land as an even 3 x 3 block.
          Splitting them across two grids left a ragged 4 / 2 / 3 layout with the
          second row half empty. */}
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        <DashboardKpiCards kpis={k} isLoading={kpis.isLoading} isCardVisible={isCardVisible} />
      </div>

      {/* Tables Grid */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Recent Invoices Card */}
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-card shadow-md transition-shadow hover:shadow-lg dark:border-slate-800">
          <header className="flex flex-wrap items-center justify-between gap-3 bg-gradient-to-r from-blue-600 to-blue-700 px-5 py-4 text-white">
            <h2 className="text-base font-bold tracking-wide">
              {t("adminDashboard.monthlyInvoices")}
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={String(selectedMonth)}
                onValueChange={(value) => setSelectedMonth(Number(value))}
              >
                <SelectTrigger
                  aria-label={t("adminDashboard.month")}
                  className="h-8 w-auto min-w-[7rem] border-white/30 bg-white/15 text-white focus:ring-white/40"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {monthOptions.map((month) => (
                    <SelectItem key={month.value} value={String(month.value)}>
                      {month.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={String(selectedYear)}
                onValueChange={(value) => setSelectedYear(Number(value))}
              >
                <SelectTrigger
                  aria-label={t("adminDashboard.year")}
                  className="h-8 w-auto min-w-[5rem] border-white/30 bg-white/15 text-white focus:ring-white/40"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {yearOptions.map((year) => (
                    <SelectItem key={year} value={String(year)}>
                      {year}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Link
                to="/admin/invoices"
                search={{ year: selectedYear, month: selectedMonth }}
                className="text-xs font-semibold text-blue-100 hover:text-white hover:underline transition-colors"
              >
                {t("adminDashboard.viewAll")}
              </Link>
            </div>
          </header>
          <div className="max-h-[28rem] divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
            {invoices.isLoading && (
              <p className="p-5 text-sm text-muted-foreground">{t("common.loading")}</p>
            )}
            {invoices.data?.items?.length === 0 && (
              <p className="p-5 text-sm text-muted-foreground">{t("common.empty")}</p>
            )}
            {invoices.data?.items?.map((row) => {
              const issueDate = row.issue_date ? new Date(row.issue_date) : now;
              const rowYear = row.period_year ?? issueDate.getFullYear();
              const rowMonth = row.period_month ?? issueDate.getMonth() + 1;
              const tenantName = row.tenant ? tenantDisplayName(row.tenant, locale) : "—";
              // Show the billing period (the month each invoice is for), not the
              // issue date — every invoice was issued the same day, so issue_date
              // made distinct monthly invoices look like duplicates for one month.
              const periodLabel = new Intl.DateTimeFormat(
                locale === "ar" ? "ar-KW-u-nu-latn" : "en-KW",
                {
                  month: "long",
                  year: "numeric",
                },
              ).format(new Date(rowYear, rowMonth - 1, 1));

              return (
                <Link
                  key={row.id}
                  to="/admin/invoices"
                  search={{ year: rowYear, month: rowMonth }}
                  className="flex items-center justify-between gap-3 p-4 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 truncate text-sm font-bold text-foreground">
                      <span className="font-mono">{row.code}</span>
                      <span className="text-xs font-normal text-muted-foreground">·</span>
                      <span className="truncate text-xs font-normal text-muted-foreground">
                        {tenantName}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{periodLabel}</div>
                  </div>

                  {/* Middle Column: Invoice Status Badge (cloned dimensions matching Overdue button) */}
                  <div className="shrink-0 px-2">
                    <InvoiceStatusBadge state={row.state} locale={locale} />
                  </div>

                  <div className="text-end shrink-0 min-w-[90px]">
                    <div className="text-sm font-extrabold text-blue-600 dark:text-blue-400">
                      {cur(Number(row.total ?? 0))}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t("adminDashboard.balance")}: {cur(Number(row.balance ?? 0))}
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>

        {/* Recent Payments Card */}
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-card shadow-md transition-shadow hover:shadow-lg dark:border-slate-800">
          <header className="flex items-center justify-between bg-gradient-to-r from-emerald-600 to-emerald-700 px-5 py-4 text-white">
            <h2 className="text-base font-bold tracking-wide">
              {t("adminDashboard.recentPayments")}
            </h2>
            <Link
              to="/admin/payments"
              className="text-xs font-semibold text-emerald-100 hover:text-white hover:underline transition-colors"
            >
              {t("adminDashboard.viewAll")}
            </Link>
          </header>
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            {payments.isLoading && (
              <p className="p-5 text-sm text-muted-foreground">{t("common.loading")}</p>
            )}
            {payments.data?.length === 0 && (
              <p className="p-5 text-sm text-muted-foreground">{t("common.empty")}</p>
            )}
            {payments.data?.map((row: any) => {
              const tenantName = row.tenants ? tenantDisplayName(row.tenants, locale) : "—";

              return (
                <Link
                  key={row.id}
                  to="/admin/payments"
                  className="flex items-center justify-between gap-3 p-4 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 truncate text-sm font-bold text-foreground">
                      <span className="font-mono">{row.code}</span>
                      <span className="text-xs font-normal text-muted-foreground">·</span>
                      <span className="truncate text-xs font-normal text-muted-foreground">
                        {tenantName}
                      </span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {formatDate(row.payment_date, dir)}
                    </div>
                  </div>

                  {/* Middle Column: Payment Status & Method Badge Button */}
                  <div className="shrink-0 px-2">
                    <PaymentStatusBadge status={row.status} method={row.method} locale={locale} />
                  </div>

                  <div className="text-end shrink-0 min-w-[90px] text-sm font-extrabold text-emerald-600 dark:text-emerald-400">
                    {cur(Number(row.amount ?? 0))}
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
