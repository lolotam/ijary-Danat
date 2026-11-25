interface ActiveContractCandidate {
  id: string;
  tenant_id: string;
  /** Every unit the contract holds (migration 110) — a contract is no longer
   *  pinned to exactly one. */
  unit_ids: string[];
  state: string;
  start_date: string;
  end_date: string | null;
}

/**
 * Every active contract per tenant, newest start first.
 *
 * A tenant may hold more than one contract at a time — a second shop, a second
 * unit in the same building — and `contracts.tenant_id` has never constrained
 * that. Callers that can only show one location use
 * `selectActiveContractByTenant` below; callers that show all of them use this.
 */
export function selectActiveContractsByTenant<T extends ActiveContractCandidate>(
  contracts: T[],
): Map<string, T[]> {
  return contracts
    .filter((contract) => contract.state === "active")
    .sort((left, right) => right.start_date.localeCompare(left.start_date))
    .reduce((byTenant, contract) => {
      const forTenant = byTenant.get(contract.tenant_id);
      if (forTenant) forTenant.push(contract);
      else byTenant.set(contract.tenant_id, [contract]);
      return byTenant;
    }, new Map<string, T[]>());
}

/**
 * The newest active contract per tenant.
 *
 * Derived from the plural selector rather than repeating the filter and sort,
 * so "newest active contract" has one definition. Two independent
 * implementations would drift, and this one still feeds the tenants list's sort
 * accessors and CSV export, where a single value is required.
 */
export function selectActiveContractByTenant<T extends ActiveContractCandidate>(
  contracts: T[],
): Map<string, T> {
  return new Map(
    [...selectActiveContractsByTenant(contracts)].map(([tenantId, forTenant]) => [
      tenantId,
      forTenant[0],
    ]),
  );
}

/**
 * يرتّب العقود من الأقدم حتى يتطابق التبويب الأول مع الشعار الافتراضي.
 *
 * The tenant-detail tab strip and the page-level logo must share one order:
 * if they drifted, the logo would advertise a different contract than the
 * open tab.
 */
export function orderContractsOldestFirst<T extends { start_date: string }>(contracts: T[]): T[] {
  return [...contracts].sort((left, right) => left.start_date.localeCompare(right.start_date));
}

/**
 * Distinct entries by id, preserving first-seen order.
 *
 * Two contracts in the same building must show that building once. Unlike a
 * building, a unit is no longer a reliable proxy for "one contract" — a single
 * contract can now hold several units (migration 110), so two entries sharing
 * an id are just as likely to be two units *of the same contract* as two units
 * from two different contracts.
 */
export function dedupeById<T extends { id: string }>(records: Array<T | null>): T[] {
  const byId = new Map<string, T>();
  for (const record of records) {
    if (record && !byId.has(record.id)) byId.set(record.id, record);
  }
  return [...byId.values()];
}

/**
 * يحلّ كل وحدات العقد ومبانيها، لا الوحدة الأولى فقط.
 *
 * The tenants list resolved `unit_ids[0]` alone, so a three-unit contract
 * showed one unit and a contract spanning two buildings showed one building —
 * while the tenant detail page, reading the same contract, showed all of them.
 *
 * Order is `unit_ids` order, which callers supply sorted by `line_order`, so
 * `[0]` remains the contract's primary. That still matters: the tenants list
 * sorts and exports on a single unit and a single building, and a sort key that
 * is an array has no meaning.
 *
 * Units with no row in `unitById` are dropped rather than rendered as gaps —
 * an id that resolves to nothing is a unit the reader has no access to or that
 * no longer exists, and an empty slot in a list of links reads as a bug.
 */
export function resolveContractLocation<
  TUnit extends { id: string; property_id: string },
  TProperty extends { id: string },
>(
  unitIds: string[],
  unitById: Map<string, TUnit>,
  propertyById: Map<string, TProperty>,
): { units: TUnit[]; properties: TProperty[] } {
  const units = unitIds
    .map((unitId) => unitById.get(unitId))
    .filter((unit): unit is TUnit => unit !== undefined);
  return {
    units,
    properties: dedupeById(units.map((unit) => propertyById.get(unit.property_id) ?? null)),
  };
}
