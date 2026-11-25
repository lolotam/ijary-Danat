/**
 * Map Settings → Lists catalogue rows into select options for free-text columns
 * such as `contracts.commercial_activity`, `units.floor`, `units.type`, and
 * `properties.type`.
 *
 * Free-text columns (migrations 99 / 101 / 103) — intentionally NO allow-list
 * filter. `useListDrivenOptions` filters against Postgres enum values; that
 * would hide every value the owner later adds in Settings → Lists and defeat
 * the point of a settings-driven dropdown. Callers must feed items from
 * `useOptionListItemsByCode(...)` (already active-only).
 *
 * One shared mapper keeps commercial activity, floors, unit types, and property
 * types from drifting into near-identical copies.
 */
export type CatalogueOptionItem = {
  value: string;
  label_ar: string | null;
  label_en: string | null;
};

/** @deprecated Prefer CatalogueOptionItem — alias kept for existing call sites. */
export type CommercialActivityItem = CatalogueOptionItem;

export function mapCatalogueOptions(
  items: readonly CatalogueOptionItem[],
  locale: "ar" | "en",
): Array<{ value: string; label: string }> {
  return items.map((item) => ({
    value: item.value,
    label: (locale === "ar" ? item.label_ar : item.label_en) || item.value,
  }));
}

/** Alias — same function; name kept so commercial-activity call sites stay clear. */
export const mapCommercialActivityOptions = mapCatalogueOptions;

/**
 * يحوّل قيمة حرة مخزّنة في قاعدة البيانات إلى التسمية المعروضة بلغة الواجهة.
 *
 * The mirror image of `mapCatalogueOptions`: that one labels the dropdown, this
 * one labels a stored value in a table cell or a badge. Both had to exist and
 * only the first one did — which is why `/admin/units` rendered the raw key
 * `unitType.commercial_unit` for a type the owner added in Settings → Lists
 * while the unit form's dropdown showed it correctly all along.
 *
 * Resolution order: catalogue label for the active locale → the legacy
 * dictionary key → the raw stored value.
 *
 * The dictionary step exists only for the case where the catalogue is still
 * loading or unreadable (the tenant portal may not hold a read policy on
 * `option_list_items`); the seven seeds keep their translations there. It can
 * never cover a value added after the dictionary was written, so the catalogue
 * is the source of truth after migration 103.
 *
 * `translate` is `t()`, which returns the key itself when the key is missing —
 * silently, with no error. That fallback is precisely the bug being fixed, so
 * this compares the result against the key rather than trusting it.
 */
export type CatalogueLabelRequest = {
  items: readonly CatalogueOptionItem[];
  locale: "ar" | "en";
  /** The value as stored on the row — `units.type`, `properties.type`, … */
  value: string;
  /** `t()` from the i18n provider. */
  translate: (key: string) => string;
  /** Dictionary family for the legacy fallback, e.g. `"unitType"`. */
  translatePrefix: string;
};

export function catalogueLabelFor({
  items,
  locale,
  value,
  translate,
  translatePrefix,
}: CatalogueLabelRequest): string {
  const item = items.find((candidate) => candidate.value === value);
  const label = item && (locale === "ar" ? item.label_ar : item.label_en);
  if (label) return label;

  const key = `${translatePrefix}.${value}`;
  const translated = translate(key);
  return translated === key ? value : translated;
}

/** Seven starter values seeded by migration 99 — for regression tests only. */
export const SEEDED_COMMERCIAL_ACTIVITIES = [
  "bakery",
  "grocery",
  "fish_shop",
  "mobile_shop",
  "salon",
  "pharmacy",
  "restaurant",
] as const;

/** Five historical property-type seeds — for free-text regression tests only. */
export const SEEDED_PROPERTY_TYPES = [
  "compound",
  "building_complex",
  "tower",
  "villa_compound",
  "other",
] as const;
