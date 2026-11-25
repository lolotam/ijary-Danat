/**
 * حالة شريط تصفية جدول العقود: المبنى، المستأجر، ونطاق تاريخ الانتهاء.
 *
 * `state` is deliberately absent. It was already a server-side filter before
 * this bar existed and it also narrows the KPI cards through
 * `useContractsSummary`; moving it here would have quietly stopped the cards
 * responding to it. It stays wired to the query and only its control moved
 * into the bar.
 *
 * The rest run in the browser over the whole loaded list. A contract's building
 * comes from `contract_units → units.property_id`, which PostgREST cannot
 * filter the contracts table on in one request, and the page now fetches every
 * contract at once (pagination removed), so the browser sees the full set.
 */
export interface ContractTableFilters {
  propertyId: string;
  tenantId: string;
  /** Inclusive ISO bounds on `end_date`; "" means unbounded on that side. */
  expiryFrom: string;
  expiryTo: string;
  /** "" = any, "yes" = has overdue invoices, "no" = has none. */
  arrears: string;
}

/** لا تصفية: كل الحقول فارغة. */
export const emptyContractTableFilters: ContractTableFilters = {
  propertyId: "",
  tenantId: "",
  expiryFrom: "",
  expiryTo: "",
  arrears: "",
};

/** هل يوجد أي مرشِّح مفعَّل؟ يقرِّر إظهار زر "مسح التصفية". */
export function hasActiveContractTableFilters(filters: ContractTableFilters): boolean {
  return Object.values(filters).some((value) => value !== "");
}

/** أقل ما يحتاجه المرشِّح من صف العقد، حتى تبقى الدالة قابلة للاختبار بلا استعلام. */
export interface ContractFilterRow {
  tenant_id: string;
  /** NOT NULL on `contracts` — every contract has an end date. */
  end_date: string;
  units: Array<{ property: { id: string } | null }>;
  /** هل للعقد فاتورة متأخرة برصيد قائم — نفس ما يرسمه الشارة في الجدول. */
  hasOverdue: boolean;
}

/**
 * يصفّي صفوف العقود حسب المبنى والمستأجر ونطاق تاريخ الانتهاء والمتأخرات.
 *
 * Matches on any of the contract's units, not `primaryUnit`: a contract holding
 * shops in two buildings is a contract of both, and filtering by the second one
 * has to find it.
 *
 * Arrears reads the same `hasOverdue` the status column's badge draws from, so
 * "in arrears" selects exactly the rows already wearing the badge. Deriving it
 * a second time here would let the filter and the badge drift apart.
 *
 * Dates compare as strings because `end_date` is an ISO `YYYY-MM-DD` date —
 * lexicographic order is chronological order there, and parsing it into a
 * `Date` would drag the browser's timezone into a comparison that has none.
 */
export function filterContracts<T extends ContractFilterRow>(
  items: readonly T[],
  filters: ContractTableFilters,
): T[] {
  return items.filter((contract) => {
    if (filters.tenantId && contract.tenant_id !== filters.tenantId) return false;
    if (filters.expiryFrom && contract.end_date < filters.expiryFrom) return false;
    if (filters.expiryTo && contract.end_date > filters.expiryTo) return false;
    if (filters.arrears === "yes" && !contract.hasOverdue) return false;
    if (filters.arrears === "no" && contract.hasOverdue) return false;
    if (
      filters.propertyId &&
      !contract.units.some((line) => line.property?.id === filters.propertyId)
    ) {
      return false;
    }
    return true;
  });
}

/**
 * خيارات قائمة المستأجرين، مستخرَجة من العقود المعروضة نفسها.
 *
 * Built from the loaded rows rather than a second query of every tenant: only
 * tenants who actually hold a contract can narrow this table, and offering the
 * rest would be a list of choices that all return nothing. Sorted by the
 * displayed label so the order matches what the reader sees, and deduplicated
 * because a tenant with three contracts is still one tenant.
 */
export function contractTenantOptions<T extends { tenant_id: string }>(
  items: readonly T[],
  labelOf: (item: T) => string | null,
): Array<{ value: string; label: string }> {
  const labelById = new Map<string, string>();
  for (const item of items) {
    const label = labelOf(item);
    if (label && !labelById.has(item.tenant_id)) labelById.set(item.tenant_id, label);
  }
  return [...labelById]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
