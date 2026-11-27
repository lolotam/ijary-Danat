import {
  makeTarget,
  type ColumnSetMap,
  type CompanyTableTarget,
} from "@/db/isolation/seedGraphHelpers";

/**
 * يبني هدف مصفوفة العزل لجدول `company_modules` (ترحيل 320).
 *
 * Staff hold SELECT only on their own company's rows and no write grant, so
 * every cross-company write is refused before RLS; the matrix proves a staff
 * member can neither read nor change another company's section switches.
 */
export function buildModuleMatrixTargets(
  companyId: string,
  colMap: ColumnSetMap,
): CompanyTableTarget[] {
  if (!colMap.has("company_modules")) return [];
  return [
    makeTarget("company_modules", "company_id", companyId, "enabled", false, () => ({
      // A key the seed leaves unset, so an insert that ever got past the grant
      // would not collide with the seeded `(company_id, module_key)` row.
      values: { module_key: "maintenance", enabled: true },
    })),
  ];
}
