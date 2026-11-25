interface UnitLike {
  id: string;
  property_id: string;
}

/**
 * Units across every selected property, in the order the units were given.
 *
 * Empty when nothing is selected: the picker must start empty rather than
 * offering every unit in the portfolio, which is what a naive "no filter means
 * no filtering" reading would produce.
 */
export function aggregateUnitsForProperties<T extends UnitLike>(
  units: T[],
  propertyIds: string[],
): T[] {
  if (!propertyIds.length) return [];
  const selected = new Set(propertyIds);
  return units.filter((unit) => selected.has(unit.property_id));
}

/**
 * أقصى عدد وحدات *معروضة* يُسأل عنها استعلام الإشغال دفعة واحدة.
 *
 * The ids travel in a PostgREST `in.(…)` filter, which is a GET query string;
 * a UUID list long enough to pass the proxy's URI limit comes back as a 414 or,
 * worse, truncated. This portfolio holds ~70 units, so the cap is headroom
 * rather than a limit anyone reaches — it exists so an imported portfolio ten
 * times the size degrades the badge instead of the request.
 *
 * It bounds the *badge* population only. Selected ids are always included, so a
 * contract with more selected units than this would still send an oversized
 * request — the alternative, dropping one, would skip the save guard for it,
 * and a missing badge is a far better failure than a double-let unit. Raised in
 * review of PR #138: if that ever becomes reachable, the fix is to batch the
 * query in `useUnitsActiveContracts`, not to truncate here.
 */
export const OCCUPANCY_UNIT_ID_LIMIT = 200;

/**
 * معرّفات الوحدات التي يُسأل عنها الإشغال: المعروضة حاليًا مع المختارة فعلًا.
 *
 * The selected ids are unioned in, and kept first when the cap bites, because
 * they are the ones the save guard checks. Dropping a selected id would not
 * show a missing badge — it would silently let a contract be saved onto a unit
 * that another live contract already holds.
 */
export function cappedOccupancyUnitIds(
  availableUnitIds: string[],
  selectedUnitIds: string[],
): string[] {
  const seen = new Set(selectedUnitIds);
  const ordered = [...seen];
  for (const id of availableUnitIds) {
    if (ordered.length >= OCCUPANCY_UNIT_ID_LIMIT) break;
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
  }
  return ordered;
}

/** The contract's rent — mirrors the trigger that maintains contracts.monthly_amount. */
export function totalMonthlyAmount(rows: Array<{ monthly_amount: number }>): number {
  return rows.reduce((sum, row) => sum + row.monthly_amount, 0);
}

/**
 * Joins display labels for one message — a single template slot ("the unit")
 * now names as many units as the contract holds.
 *
 * Arabic uses "، " (comma with the Arabic glyph) rather than the Latin ", " to
 * match how the surrounding bilingual bodies punctuate lists; every other
 * locale falls back to the Latin comma. Never picks just the first label —
 * a tenant on a two-unit contract has to see both units named, not one.
 */
export function joinLocalizedList(labels: string[], locale: "ar" | "en"): string {
  return labels.join(locale === "ar" ? "، " : ", ");
}
