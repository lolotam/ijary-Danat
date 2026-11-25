/**
 * Floor → unit-type binding for the add/edit unit form.
 *
 * A module, not a column on `option_list_items`: four magic strings in a
 * tested map are the same exposure as four magic strings behind a generic FK
 * and an editor screen — the owner editing a *value* by hand would still
 * break the binding. Migration 148 seeds the four targets so a freshly-built
 * database has the same rows as production (`commercial_unit_basment` typo
 * included — that is the owner's data, not ours to tidy).
 *
 * The roof target is `managemental-services` (migration 239 renamed the old
 * `Roof_Apartment` value and cascaded the stored rows), and because the map's
 * values are literals the floor-lock and roof detection read, `isCodeBoundValue`
 * refuses a Settings → Lists rename of any value that appears here.
 */
export const UNIT_FLOOR_TYPE_BINDING: Readonly<Record<string, string>> = {
  first: "commercial_unit_1st_floor",
  basement: "commercial_unit_basment",
  roof: "managemental-services",
  ground: "shop_G_Floor",
};

/**
 * يحدد ما إذا كانت القيمة مربوطة في الشيفرة فلا يجوز تغييرها من الإعدادات.
 *
 * The binding is keyed by unit_floors values and points at unit_types values;
 * renaming either in the database would silently break the floor lock —
 * `resolveUnitTypeBinding` would stop matching and the locked type select
 * would free itself without anyone noticing.
 */
export function isCodeBoundValue(listCode: string, value: string): boolean {
  if (listCode === "unit_floors") return Object.hasOwn(UNIT_FLOOR_TYPE_BINDING, value);
  if (listCode === "unit_types") return Object.values(UNIT_FLOOR_TYPE_BINDING).includes(value);
  return false;
}

/**
 * يُرجع نوع الوحدة المربوط بقيمة الطابق، أو null إن لم يكن للطابق ربط.
 *
 * Lookup is exact: the owner's catalogue values are mixed-case and one is
 * misspelt, so normalising here would miss the seeded rows.
 */
export function boundUnitTypeFor(floorValue: string | null | undefined): string | null {
  if (floorValue == null) return null;
  return UNIT_FLOOR_TYPE_BINDING[floorValue] ?? null;
}

/**
 * يقرر نوع الوحدة المربوط بالطابق وما إذا كان حقل النوع يُقفل.
 *
 * `locked` is true only when the mapped type is still in Settings → Lists.
 * A locked select pointing at a deleted option renders empty and cannot be
 * corrected; a free field with the stale-value hatch is the safe failure.
 */
export function resolveUnitTypeBinding(input: {
  floor: string | null | undefined;
  activeTypeValues: readonly string[];
}): { boundType: string | null; locked: boolean } {
  const boundType = boundUnitTypeFor(input.floor);
  if (!boundType) return { boundType: null, locked: false };
  return { boundType, locked: input.activeTypeValues.includes(boundType) };
}
