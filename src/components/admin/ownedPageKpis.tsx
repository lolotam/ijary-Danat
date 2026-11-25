import {
  AlertTriangle,
  BadgeDollarSign,
  Banknote,
  Building2,
  CalendarDays,
  CheckCircle2,
  Clock,
  DoorClosed,
  DoorOpen,
  FileText,
  Home,
  Receipt,
  ReceiptText,
  Users,
  Wallet,
  Wrench,
} from "lucide-react";

import { VibrantKpiCard } from "@/components/shared/dashboardCards";
import { LtrText } from "@/components/ui/ltr-text";
import type { DepositsSummary } from "@/hooks/useDepositsSummary";
import type { ExpensesSummary } from "@/hooks/useExpensesSummary";
import type { UnitsSummary } from "@/hooks/useUnitsSummary";
import { useI18n } from "@/i18n/provider";
import { formatKwd } from "@/lib/money";

export interface DashboardKpiValues {
  invoicesOutstanding: number;
  invoicesFuture: number;
  futureCount: number;
  invoicesPaid: number;
  invoicesOverdue: number;
  overdueCount: number;
  paymentsThisMonth: number;
  tenants: number;
  activeTenants: number;
  units: number;
  occupiedUnits: number;
  properties: number;
  employees: number;
  salariesPaid: number;
}

/**
 * بطاقات مؤشرات لوحة التحكم التسعة، محجوبة حسب إعدادات الشركة.
 */
export function DashboardKpiCards({
  kpis,
  isLoading = false,
  isCardVisible,
}: {
  kpis?: DashboardKpiValues;
  isLoading?: boolean;
  isCardVisible: (id: string) => boolean;
}) {
  const { t, locale } = useI18n();
  const cur = (value: number) => formatKwd(value, locale);

  return (
    <>
      {isCardVisible("dashboard.outstanding") && (
        <VibrantKpiCard
          label={t("ownedPageKpis.outstandingBalance")}
          value={isLoading ? "…" : cur(kpis?.invoicesOutstanding ?? 0)}
          hint={t("ownedPageKpis.dueNowFuture")
            .replace("{amount}", cur(kpis?.invoicesFuture ?? 0))
            .replace("{count}", (kpis?.futureCount ?? 0).toLocaleString("en-US"))}
          icon={<Wallet className="size-6 text-white" />}
          bgClass="bg-gradient-to-br from-blue-600 via-blue-600 to-indigo-700 shadow-blue-500/25"
          href="/admin/invoices"
        />
      )}
      {isCardVisible("dashboard.paymentsThisMonth") && (
        <VibrantKpiCard
          label={t("ownedPageKpis.paymentsThisMonth")}
          value={isLoading ? "…" : cur(kpis?.paymentsThisMonth ?? 0)}
          hint={t("ownedPageKpis.confirmedPaymentsOnly")}
          icon={<ReceiptText className="size-6 text-white" />}
          bgClass="bg-gradient-to-br from-emerald-500 via-emerald-600 to-teal-700 shadow-emerald-500/25"
          href="/admin/payments"
        />
      )}
      {isCardVisible("dashboard.overdue") && (
        <VibrantKpiCard
          label={t("ownedPageKpis.overdueInvoices")}
          // The count is the headline; the money it represents is the hint. The
          // card used to print the KWD total with no unit, so 205,195 KWD read
          // as 205,195 invoices.
          value={isLoading ? "…" : (kpis?.overdueCount ?? 0).toLocaleString("en-US")}
          hint={t("ownedPageKpis.overdueAmount").replace(
            "{amount}",
            cur(kpis?.invoicesOverdue ?? 0),
          )}
          icon={<AlertTriangle className="size-6 text-white" />}
          bgClass="bg-gradient-to-br from-amber-500 via-amber-600 to-orange-600 shadow-amber-500/25"
          href="/admin/invoices"
        />
      )}
      {isCardVisible("dashboard.collected") && (
        <VibrantKpiCard
          label={t("ownedPageKpis.totalCollected")}
          value={isLoading ? "…" : cur(kpis?.invoicesPaid ?? 0)}
          hint={t("ownedPageKpis.sinceInception")}
          icon={<FileText className="size-6 text-white" />}
          bgClass="bg-gradient-to-br from-teal-500 via-teal-600 to-cyan-700 shadow-teal-500/25"
          href="/admin/invoices"
        />
      )}
      {isCardVisible("dashboard.employees") && (
        <VibrantKpiCard
          label={t("ownedPageKpis.employees")}
          value={isLoading ? "…" : (kpis?.employees ?? 0).toLocaleString("en-US")}
          hint={t("ownedPageKpis.currentlyEmployed")}
          icon={<BadgeDollarSign className="size-6 text-white" />}
          bgClass="bg-gradient-to-br from-violet-500 via-violet-600 to-purple-700 shadow-violet-500/25"
          href="/admin/employees"
        />
      )}
      {isCardVisible("dashboard.salaries") && (
        <VibrantKpiCard
          label={t("ownedPageKpis.salariesPaid")}
          value={isLoading ? "…" : cur(kpis?.salariesPaid ?? 0)}
          hint={t("ownedPageKpis.deliveredThisMonth")}
          icon={<Wallet className="size-6 text-white" />}
          bgClass="bg-gradient-to-br from-fuchsia-500 via-fuchsia-600 to-pink-700 shadow-fuchsia-500/25"
          href="/admin/employees"
        />
      )}
      {isCardVisible("dashboard.properties") && (
        <VibrantKpiCard
          label={t("ownedPageKpis.properties")}
          value={isLoading ? "…" : (kpis?.properties ?? 0).toLocaleString("en-US")}
          hint={t("ownedPageKpis.registeredProperties")}
          icon={<Building2 className="size-6 text-white" />}
          bgClass="bg-gradient-to-br from-indigo-600 via-indigo-700 to-purple-800 shadow-indigo-500/25"
          href="/admin/properties"
        />
      )}
      {isCardVisible("dashboard.units") && (
        <VibrantKpiCard
          label={t("ownedPageKpis.units")}
          value={
            isLoading
              ? "…"
              : `${(kpis?.occupiedUnits ?? 0).toLocaleString("en-US")} / ${(kpis?.units ?? 0).toLocaleString("en-US")}`
          }
          hint={t("ownedPageKpis.occupiedTotal")}
          icon={<Home className="size-6 text-white" />}
          bgClass="bg-gradient-to-br from-purple-600 via-fuchsia-600 to-pink-700 shadow-purple-500/25"
          href="/admin/units"
          progressBar={{ current: kpis?.occupiedUnits ?? 0, total: kpis?.units ?? 1 }}
        />
      )}
      {isCardVisible("dashboard.tenants") && (
        <VibrantKpiCard
          label={t("ownedPageKpis.tenants")}
          value={
            isLoading
              ? "…"
              : `${(kpis?.activeTenants ?? 0).toLocaleString("en-US")} / ${(kpis?.tenants ?? 0).toLocaleString("en-US")}`
          }
          hint={t("ownedPageKpis.activeTotal")}
          icon={<Users className="size-6 text-white" />}
          bgClass="bg-gradient-to-br from-orange-500 via-orange-600 to-red-600 shadow-orange-500/25"
          href="/admin/tenants"
          progressBar={{ current: kpis?.activeTenants ?? 0, total: kpis?.tenants ?? 1 }}
        />
      )}
    </>
  );
}

/**
 * بطاقات مؤشرات صفحة الوحدات، محجوبة حسب إعدادات الشركة.
 */
export function UnitsKpiCards({
  summary,
  isCardVisible,
}: {
  summary?: UnitsSummary;
  isCardVisible: (id: string) => boolean;
}) {
  const { t, locale } = useI18n();
  return (
    <>
      {isCardVisible("units.total") && (
        <VibrantKpiCard
          label={t("summary.units.total")}
          value={(summary?.total ?? 0).toLocaleString("en-US")}
          icon={<Building2 className="size-6 text-white" />}
          bgClass="bg-gradient-to-br from-slate-500 via-slate-600 to-gray-700 shadow-slate-500/25"
        />
      )}
      {isCardVisible("units.occupied") && (
        <VibrantKpiCard
          label={t("summary.units.occupied")}
          value={(summary?.occupied ?? 0).toLocaleString("en-US")}
          hint={
            summary && summary.total > 0
              ? `${Math.round((summary.occupied / summary.total) * 100)}%`
              : "0%"
          }
          icon={<DoorClosed className="size-6 text-white" />}
          bgClass="bg-gradient-to-br from-emerald-500 via-emerald-600 to-green-600 shadow-emerald-500/25"
          progressBar={{
            current: summary?.occupied ?? 0,
            total: summary?.total ?? 0,
          }}
        />
      )}
      {isCardVisible("units.vacant") && (
        <VibrantKpiCard
          label={t("summary.units.vacant")}
          value={(summary?.vacant ?? 0).toLocaleString("en-US")}
          icon={<DoorOpen className="size-6 text-white" />}
          bgClass="bg-gradient-to-br from-sky-500 via-sky-600 to-blue-600 shadow-sky-500/25"
        />
      )}
      {isCardVisible("units.maintenance") && (
        <VibrantKpiCard
          label={t("summary.units.maintenance")}
          value={(summary?.underMaintenance ?? 0).toLocaleString("en-US")}
          icon={<Wrench className="size-6 text-white" />}
          bgClass="bg-gradient-to-br from-amber-500 via-amber-600 to-orange-600 shadow-amber-500/25"
        />
      )}
      {isCardVisible("units.rentPotential") && (
        <VibrantKpiCard
          label={t("summary.units.rentPotential")}
          value={<LtrText>{formatKwd(summary?.rentPotential ?? 0, locale)}</LtrText>}
          icon={<Banknote className="size-6 text-white" />}
          bgClass="bg-gradient-to-br from-violet-500 via-violet-600 to-purple-600 shadow-violet-500/25"
        />
      )}
    </>
  );
}

/**
 * بطاقات مؤشرات صفحة التأمينات، محجوبة حسب إعدادات الشركة.
 */
export function DepositsKpiCards({
  summary,
  isCardVisible,
}: {
  summary?: DepositsSummary;
  isCardVisible: (id: string) => boolean;
}) {
  const { t, locale } = useI18n();
  return (
    <>
      {isCardVisible("deposits.total") && (
        <VibrantKpiCard
          label={t("summary.deposits.total")}
          value={<LtrText>{formatKwd(summary?.total.amount ?? 0, locale)}</LtrText>}
          hint={`${summary?.total.count ?? 0} ${t("summary.records")}`}
          icon={<Wallet className="size-6 text-white" />}
          bgClass="bg-gradient-to-br from-teal-500 via-teal-600 to-cyan-700 shadow-teal-500/25"
        />
      )}
      {isCardVisible("deposits.confirmed") && (
        <VibrantKpiCard
          label={t("summary.deposits.confirmed")}
          value={<LtrText>{formatKwd(summary?.confirmed.amount ?? 0, locale)}</LtrText>}
          hint={`${summary?.confirmed.count ?? 0} ${t("summary.records")}`}
          icon={<CheckCircle2 className="size-6 text-white" />}
          bgClass="bg-gradient-to-br from-emerald-500 via-emerald-600 to-green-600 shadow-emerald-500/25"
        />
      )}
      {isCardVisible("deposits.pending") && (
        <VibrantKpiCard
          label={t("summary.deposits.pending")}
          value={<LtrText>{formatKwd(summary?.pending.amount ?? 0, locale)}</LtrText>}
          hint={`${summary?.pending.count ?? 0} ${t("summary.records")}`}
          icon={<Clock className="size-6 text-white" />}
          bgClass="bg-gradient-to-br from-amber-500 via-amber-600 to-orange-600 shadow-amber-500/25"
        />
      )}
      {isCardVisible("deposits.thisMonth") && (
        <VibrantKpiCard
          label={t("summary.deposits.thisMonth")}
          value={<LtrText>{formatKwd(summary?.thisMonth.amount ?? 0, locale)}</LtrText>}
          hint={`${summary?.thisMonth.count ?? 0} ${t("summary.records")}`}
          icon={<CalendarDays className="size-6 text-white" />}
          bgClass="bg-gradient-to-br from-indigo-500 via-indigo-600 to-blue-700 shadow-indigo-500/25"
        />
      )}
    </>
  );
}

/**
 * بطاقات مؤشرات صفحة المصروفات، محجوبة حسب إعدادات الشركة.
 */
export function ExpensesKpiCards({
  summary,
  isCardVisible,
}: {
  summary?: ExpensesSummary;
  isCardVisible: (id: string) => boolean;
}) {
  const { t, locale } = useI18n();
  return (
    <>
      {isCardVisible("expenses.total") && (
        <VibrantKpiCard
          label={t("summary.expenses.total")}
          value={<LtrText>{formatKwd(summary?.total.amount ?? 0, locale)}</LtrText>}
          hint={`${summary?.total.count ?? 0} ${t("summary.records")}`}
          icon={<Receipt className="size-6 text-white" />}
          bgClass="bg-gradient-to-br from-amber-500 via-amber-600 to-orange-600 shadow-amber-500/25"
        />
      )}
      {isCardVisible("expenses.approved") && (
        <VibrantKpiCard
          label={t("summary.expenses.approved")}
          value={<LtrText>{formatKwd(summary?.approved.amount ?? 0, locale)}</LtrText>}
          hint={`${summary?.approved.count ?? 0} ${t("summary.records")}`}
          icon={<CheckCircle2 className="size-6 text-white" />}
          bgClass="bg-gradient-to-br from-emerald-500 via-emerald-600 to-green-600 shadow-emerald-500/25"
        />
      )}
      {isCardVisible("expenses.pending") && (
        <VibrantKpiCard
          label={t("summary.expenses.pending")}
          value={<LtrText>{formatKwd(summary?.pending.amount ?? 0, locale)}</LtrText>}
          hint={`${summary?.pending.count ?? 0} ${t("summary.records")}`}
          icon={<Clock className="size-6 text-white" />}
          bgClass="bg-gradient-to-br from-slate-500 via-slate-600 to-gray-700 shadow-slate-500/25"
        />
      )}
      {isCardVisible("expenses.thisMonth") && (
        <VibrantKpiCard
          label={t("summary.expenses.thisMonth")}
          value={<LtrText>{formatKwd(summary?.thisMonth.amount ?? 0, locale)}</LtrText>}
          hint={`${summary?.thisMonth.count ?? 0} ${t("summary.records")}`}
          icon={<CalendarDays className="size-6 text-white" />}
          bgClass="bg-gradient-to-br from-indigo-500 via-indigo-600 to-blue-700 shadow-indigo-500/25"
        />
      )}
    </>
  );
}
