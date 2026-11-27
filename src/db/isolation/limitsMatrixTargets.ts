import {
  makeTarget,
  type ColumnSetMap,
  type CompanyTableTarget,
} from "@/db/isolation/seedGraphHelpers";

/**
 * يبني أهداف مصفوفة العزل لجداول الحدود والاستهلاك (ترحيل 323).
 *
 * Staff and `company_service` may read only their own company's rows and hold
 * no direct insert/update/delete grants on these tables, so the matrix verifies
 * that neither company can read or mutate another company's limits or usage.
 */
export function buildLimitsMatrixTargets(
  companyId: string,
  colMap: ColumnSetMap,
): CompanyTableTarget[] {
  const targets: CompanyTableTarget[] = [];

  if (colMap.has("company_limits")) {
    targets.push(
      makeTarget("company_limits", "company_id", companyId, "max_units", 999, () => ({
        values: { max_units: 5 },
      })),
    );
  }

  if (colMap.has("company_usage_monthly")) {
    targets.push(
      makeTarget("company_usage_monthly", "company_id", companyId, "whatsapp_sent", 999, () => ({
        values: { month: "2026-01-01", whatsapp_sent: 1 },
      })),
    );
  }

  if (colMap.has("company_storage_usage")) {
    targets.push(
      makeTarget("company_storage_usage", "company_id", companyId, "bytes", 999, () => ({
        values: { bytes: 100 },
      })),
    );
  }

  return targets;
}
