/**
 * حالة شريط تصفية جدول المستأجرين، كنصوص كما تصل من القوائم المنسدلة.
 *
 * Every field is a string because that is what a `<Select>` hands back, and
 * "" means "no filter" — the same contract `paymentFilters` uses, so the two
 * bars behave alike from the reader's side.
 *
 * These filters run in the browser over the whole loaded list, never as query
 * parameters. The property a tenant is in is not a column on `tenants`: it is
 * derived from their active contracts' units by `attachActiveLocations`, so
 * PostgREST has nothing to filter on. The page already fetches every tenant in
 * one request (pagination was removed), so filtering client-side sees the full
 * set rather than one page of it.
 */
export interface TenantTableFilters {
  propertyId: string;
  category: string;
  lifecycle: string;
  /** "" = any, "yes" = has overdue invoices, "no" = has none. */
  arrears: string;
}

/** لا تصفية: كل الحقول فارغة. */
export const emptyTenantTableFilters: TenantTableFilters = {
  propertyId: "",
  category: "",
  lifecycle: "",
  arrears: "",
};

/** هل يوجد أي مرشِّح مفعَّل؟ يقرِّر إظهار زر "مسح التصفية". */
export function hasActiveTenantTableFilters(filters: TenantTableFilters): boolean {
  return Object.values(filters).some((value) => value !== "");
}

/** أقل ما يحتاجه المرشِّح من صف المستأجر، حتى تبقى الدالة قابلة للاختبار بلا استعلام. */
export interface TenantFilterRow {
  category: string;
  lifecycle: string;
  hasOverdue: boolean;
  /** Every building the tenant's active contracts put them in. */
  connectedProperties: Array<{ id: string }>;
}

/**
 * يصفّي صفوف المستأجرين حسب المبنى والتصنيف ودورة الحالة والمتأخرات.
 *
 * The property test is `connectedProperties.some(...)`, not the primary
 * `connectedProperty`: a tenant renting shops in two buildings belongs to both,
 * and filtering by the second one has to find them. The sortable Property
 * column still shows the primary — sorting needs one value per row, matching
 * does not.
 */
export function filterTenants<T extends TenantFilterRow>(
  items: readonly T[],
  filters: TenantTableFilters,
): T[] {
  return items.filter((tenant) => {
    if (filters.category && tenant.category !== filters.category) return false;
    if (filters.lifecycle && tenant.lifecycle !== filters.lifecycle) return false;
    if (filters.arrears === "yes" && !tenant.hasOverdue) return false;
    if (filters.arrears === "no" && tenant.hasOverdue) return false;
    if (
      filters.propertyId &&
      !tenant.connectedProperties.some((property) => property.id === filters.propertyId)
    ) {
      return false;
    }
    return true;
  });
}
