import {
  makeTarget,
  type ColumnSetMap,
  type CompanyTableTarget,
} from "@/db/isolation/seedGraphHelpers";

/**
 * يبني هدف مصفوفة العزل لجدول `company_subscriptions` (ترحيل 322).
 *
 * Staff read only their own company's current subscription row and hold no
 * write grant (the platform records subscriptions through service_role), so
 * the matrix proves a staff member can neither read nor change another
 * company's subscription.
 */
export function buildSubscriptionMatrixTargets(
  companyId: string,
  colMap: ColumnSetMap,
): CompanyTableTarget[] {
  if (!colMap.has("company_subscriptions")) return [];
  return [
    makeTarget("company_subscriptions", "company_id", companyId, "plan_name", "mutated", (t) => ({
      values: {
        plan_name: `plan-${t}`,
        price: 1,
        period_start: "2026-01-01",
        renewal_date: "2026-02-01",
      },
    })),
  ];
}
