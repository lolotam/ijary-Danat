import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { numberValue } from "@/lib/json";

export interface KpiSet {
  /** رصيد الفواتير التي حلّ موعد استحقاقها حتى اليوم (migration 228). */
  invoicesOutstanding: number;
  /** رصيد فواتير العقود التي لم يحن موعدها بعد — حتى نهاية كل عقد. */
  invoicesFuture: number;
  /** عدد تلك الفواتير المستقبلية. */
  futureCount: number;
  invoicesPaid: number;
  invoicesOverdue: number;
  paymentsThisMonth: number;
  tenants: number;
  activeTenants: number;
  units: number;
  occupiedUnits: number;
  properties: number;
  overdueCount: number;
  /** T14a — active employees. */
  employees: number;
  /** T14a — salaries marked delivered for the current month. */
  salariesPaid: number;
}

/**
 * يحسب مؤشرات لوحة التحكم من استدعاء RPC واحد يجري المجموعات في الخادم.
 *
 * Migration 219 replaced the nine browser queries this hook used to run
 * (two paged money reads plus seven head counts): past ~1,000 rows
 * PostgREST caps an unranged read with no error, so browser-side sums
 * silently stopped being the portfolio's money (audit H10). The RPC is
 * `security invoker`, so RLS still applies to the caller. Exported so the
 * snake_case mapping and error propagation can be asserted directly:
 * mounting the whole dashboard would test the rendering, not the wiring.
 */
export async function fetchDashboardKpis(): Promise<KpiSet> {
  const { data, error } = await supabase.rpc("get_dashboard_aggregates");
  if (error) throw error;
  // Coerced through numberValue so a missing key reads as 0 rather than
  // NaN or undefined on a card.
  const agg = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  return {
    invoicesOutstanding: numberValue(agg.outstanding),
    invoicesFuture: numberValue(agg.future_outstanding),
    futureCount: numberValue(agg.future_count),
    invoicesPaid: numberValue(agg.paid),
    invoicesOverdue: numberValue(agg.overdue_amount),
    paymentsThisMonth: numberValue(agg.payments_this_month),
    tenants: numberValue(agg.tenants),
    activeTenants: numberValue(agg.active_tenants),
    units: numberValue(agg.units),
    occupiedUnits: numberValue(agg.occupied_units),
    properties: numberValue(agg.properties),
    overdueCount: numberValue(agg.overdue_count),
    employees: numberValue(agg.employees),
    // Only rows actually marked delivered count as paid — the rest are
    // generated-but-unpaid, which is the distinction the card exists to show.
    salariesPaid: numberValue(agg.salaries_paid),
  };
}

/** استعلام مؤشرات اللوحة مع تخزين مؤقت لثلاثين ثانية. */
export function useDashboardKpis() {
  return useQuery<KpiSet>({
    queryKey: ["admin", "dashboard", "kpis"],
    queryFn: fetchDashboardKpis,
    staleTime: 30_000,
  });
}
