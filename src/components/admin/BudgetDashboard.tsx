import { useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ArrowDownCircle, ArrowUpCircle, ShieldCheck, Undo2, Wallet } from "lucide-react";

import { TableState } from "@/components/admin/Phase2Ui";
import { DateInput } from "@/components/ui/date-input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { VibrantKpiCard } from "@/components/shared/dashboardCards";
import { useBudget } from "@/hooks/useBudget";
import { useProperties } from "@/hooks/useProperties";
import { useI18n } from "@/i18n/provider";
import { formatKwd } from "@/lib/money";
import { sortPropertiesByCodeNatural } from "@/lib/propertyDisplayName";

function currentYearStart(): string {
  const year = new Date().getFullYear();
  return `${year}-01-01`;
}

/**
 * Vibrant chart palette — matches the admin dashboard's colorful language.
 * Picked for legibility on white card backgrounds and consistent hue spacing.
 */
const CHART_COLORS = {
  collections: "#10b981", // emerald-500
  expenses: "#f59e0b", // amber-500
  net: "#6366f1", // indigo-500
};

// Distinct, saturated hues for the per-category pie + table accent stripes.
const CATEGORY_COLORS = [
  "#6366f1",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#06b6d4",
  "#ec4899",
  "#84cc16",
  "#f97316",
  "#14b8a6",
];

export function BudgetDashboard() {
  const { locale, t } = useI18n();
  const [from, setFrom] = useState(currentYearStart());
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [propertyId, setPropertyId] = useState<string>();
  const properties = useProperties({ page: 1, pageSize: 500 });
  const budget = useBudget({ from, to, propertyId });

  const collections = budget.data?.collections ?? 0;
  // Bank deposits are ledger-only (/admin/deposits) — not shown on budget.
  const expenses = budget.data?.expenses ?? 0;
  // T13: `refunds` deducts from net, `insurance_collected` is a holding and
  // deliberately does not. Both are new keys from migration 56.
  const refunds = budget.data?.refunds ?? 0;
  const insurance = budget.data?.insurance_collected ?? 0;
  const net = budget.data?.net ?? 0;

  const categories = budget.data?.categories ?? [];

  return (
    <div className="space-y-5">
      {/* Filter band — mirrors the admin module-header gradient cards. */}
      <div className="overflow-hidden rounded-2xl bg-gradient-to-br from-indigo-700 via-indigo-800 to-indigo-950 p-5 text-white shadow-lg sm:p-6">
        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-2">
            <Label className="text-white/80">{t("common.from")}</Label>
            <DateInput value={from} onChange={setFrom} />
          </div>
          <div className="space-y-2">
            <Label className="text-white/80">{t("common.to")}</Label>
            <DateInput value={to} onChange={setTo} />
          </div>
          <div className="space-y-2">
            <Label className="text-white/80">{t("budget.property")}</Label>
            <Select
              value={propertyId ?? "all"}
              onValueChange={(value) => setPropertyId(value === "all" ? undefined : value)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("common.all")}</SelectItem>
                {sortPropertiesByCodeNatural(properties.data?.items ?? []).map((property) => (
                  <SelectItem key={property.id} value={property.id}>
                    {property.code} —{" "}
                    {locale === "ar" ? property.name_ar : (property.name_en ?? property.name_ar)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <TableState loading={budget.isLoading} error={budget.isError} empty={false}>
        <>
          {/* KPI cards — same VibrantKpiCard the admin dashboard + portal use. */}
          <section className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
            <VibrantKpiCard
              label={t("budget.collections")}
              value={formatKwd(collections, locale)}
              hint={t("budgetDashboard.totalCollected")}
              icon={<Wallet className="size-6 text-white" />}
              bgClass="bg-gradient-to-br from-emerald-500 via-emerald-600 to-teal-700 shadow-emerald-500/25"
            />
            <VibrantKpiCard
              label={t("budget.insurance")}
              value={formatKwd(insurance, locale)}
              hint={t("budgetDashboard.totalInsurancePaid")}
              icon={<ShieldCheck className="size-6 text-white" />}
              bgClass="bg-gradient-to-br from-cyan-500 via-cyan-600 to-sky-700 shadow-cyan-500/25"
            />
            <VibrantKpiCard
              label={t("budget.refunds")}
              value={formatKwd(refunds, locale)}
              hint={t("budgetDashboard.totalRefunded")}
              icon={<Undo2 className="size-6 text-white" />}
              bgClass="bg-gradient-to-br from-rose-500 via-rose-600 to-pink-700 shadow-rose-500/25"
            />
            <VibrantKpiCard
              label={t("budget.expenses")}
              value={formatKwd(expenses, locale)}
              hint={t("budgetDashboard.totalExpenses")}
              icon={<ArrowUpCircle className="size-6 text-white" />}
              bgClass="bg-gradient-to-br from-amber-500 via-amber-600 to-orange-600 shadow-amber-500/25"
            />
            <VibrantKpiCard
              label={t("budget.net")}
              value={formatKwd(net, locale)}
              hint={net < 0 ? t("budgetDashboard.deficit") : t("budgetDashboard.surplus")}
              icon={<ArrowDownCircle className="size-6 text-white" />}
              bgClass={
                net < 0
                  ? "bg-gradient-to-br from-rose-500 via-red-600 to-rose-800 shadow-red-500/25"
                  : "bg-gradient-to-br from-indigo-500 via-violet-600 to-purple-700 shadow-indigo-500/25"
              }
            />
          </section>

          {/* Colorful section header pill (admin invoice-month style). */}
          <div className="flex justify-center">
            <span className="rounded-lg bg-gradient-to-r from-indigo-600 via-purple-600 to-indigo-600 px-6 py-1.5 text-center text-sm font-bold text-white shadow-md">
              {t("budget.monthlyComparison")}
            </span>
          </div>

          <div className="grid gap-5 xl:grid-cols-[1.35fr_1fr]">
            {/* Monthly comparison — three vibrant series. */}
            <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
              <div className="border-b bg-gradient-to-r from-emerald-600 to-teal-700 px-5 py-3">
                <h3 className="text-base font-bold text-white">{t("budget.monthlyComparison")}</h3>
              </div>
              <div className="h-80 p-4">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={budget.data?.months ?? []}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                    <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} />
                    <Tooltip
                      contentStyle={{ borderRadius: 8, border: "1px solid #e2e8f0" }}
                      formatter={(value) => formatKwd(Number(value), locale)}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Bar
                      dataKey="collections"
                      name={t("budget.collections")}
                      fill={CHART_COLORS.collections}
                      radius={[4, 4, 0, 0]}
                    />
                    <Bar
                      dataKey="expenses"
                      name={t("budget.expenses")}
                      fill={CHART_COLORS.expenses}
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Expenses by category — colorful pie + table with accent stripes. */}
            <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
              <div className="border-b bg-gradient-to-r from-amber-500 to-orange-600 px-5 py-3">
                <h3 className="text-base font-bold text-white">{t("budget.byCategory")}</h3>
              </div>
              <div className="grid gap-4 p-4 lg:grid-cols-[1fr_1fr]">
                <div className="h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={categories}
                        dataKey="amount"
                        nameKey={t("budgetDashboard.nameEn")}
                        cx="50%"
                        cy="50%"
                        outerRadius={75}
                        innerRadius={35}
                        paddingAngle={2}
                      >
                        {categories.map((entry, index) => (
                          <Cell
                            key={entry.category_id ?? entry.code ?? index}
                            fill={CATEGORY_COLORS[index % CATEGORY_COLORS.length]}
                          />
                        ))}
                      </Pie>
                      <Tooltip formatter={(value) => formatKwd(Number(value), locale)} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="self-center">
                  <TableState loading={false} error={false} empty={!categories.length}>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>#</TableHead>
                          <TableHead>{t("expenses.category")}</TableHead>
                          <TableHead>{t("common.amount")}</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {categories.map((category, index) => (
                          <TableRow key={category.category_id ?? category.code}>
                            <TableCell>
                              <span
                                className="inline-block size-2.5 rounded-full align-middle"
                                style={{
                                  backgroundColor: CATEGORY_COLORS[index % CATEGORY_COLORS.length],
                                }}
                              />
                            </TableCell>
                            <TableCell>
                              {locale === "ar" ? category.name_ar : category.name_en}
                            </TableCell>
                            <TableCell className="font-medium tabular-nums">
                              {formatKwd(category.amount, locale)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableState>
                </div>
              </div>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">{t("budget.depositScopeNote")}</p>
        </>
      </TableState>
    </div>
  );
}
