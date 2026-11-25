import type { Locale } from "@/i18n/dictionary";

/**
 * Property name for the current UI language.
 *
 * `properties.name_ar` is the primary name and is always present; `name_en` is
 * nullable, so English falls back to it rather than rendering an empty cell —
 * the same rule tenantDisplayName applies to tenants.
 *
 * Exists as a helper rather than an inline ternary because the screens that
 * need it are the ones that had drifted: the contracts table rendered
 * `name_ar` unconditionally, so an English session read Arabic property names
 * while the property list beside it read English.
 */
export function propertyDisplayName(
  property: { name_ar: string; name_en?: string | null },
  locale: Locale,
): string {
  return locale === "en" ? property.name_en?.trim() || property.name_ar : property.name_ar;
}

/**
 * ترتيب العقارات حسب الرمز ترتيبًا طبيعيًا تصاعديًا (1، 2، … 9، 10).
 *
 * `code` is the portfolio's ordering key, and a plain string sort would put
 * `10` before `2`. The `numeric` collator option compares embedded numbers by
 * value, so the dropdowns read 1 then 2 then 10 — the same comparison
 * `SortableTable` uses for its natural-sort columns.
 */
export function sortPropertiesByCodeNatural<T extends { code: string }>(
  properties: ReadonlyArray<T>,
): T[] {
  return [...properties].sort((left, right) =>
    left.code.localeCompare(right.code, undefined, { numeric: true, sensitivity: "base" }),
  );
}

/**
 * خيارات قائمة تصفية المباني: الرمز ثم الاسم بلغة الواجهة.
 *
 * The code leads because two buildings can share a name in a portfolio but
 * never a code, and the tenants and contracts filters must offer the same
 * label for the same building — a reader comparing the two screens should not
 * have to work out that they are looking at the same row.
 */
export function propertyFilterOptions(
  properties: ReadonlyArray<{ id: string; code: string; name_ar: string; name_en?: string | null }>,
  locale: Locale,
): Array<{ value: string; label: string }> {
  return sortPropertiesByCodeNatural(properties).map((property) => ({
    value: property.id,
    label: `${property.code} — ${propertyDisplayName(property, locale)}`,
  }));
}
