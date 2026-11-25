import type { Locale } from "@/i18n/dictionary";

/** The shape these helpers need — the full row is not needed. */
export interface NamedUnit {
  name: string;
  name_en?: string | null;
}

/**
 * The Arabic/English pair for a CSV export.
 *
 * Exists as a helper rather than two inline expressions because the bug it
 * replaces was invisible: before migration 54 both columns read `unit.name`, so
 * a bilingual export shipped the same value twice and nothing caught it. The
 * English column falls back to `name` so an export never carries a blank column
 * for units created before the field existed.
 */
export function unitCsvNames(unit: NamedUnit | null | undefined): {
  ar: string;
  en: string;
} {
  if (!unit) return { ar: "", en: "" };
  return { ar: unit.name, en: unit.name_en?.trim() || unit.name };
}

/**
 * Unit name for the current UI language.
 *
 * `units.name` is the primary (Arabic) name and is always present; `name_en`
 * is nullable, so English falls back to it rather than rendering an empty
 * cell — the same rule `propertyDisplayName` and `tenantDisplayName` apply.
 *
 * Added for the tenant portal, which had no such helper while properties and
 * tenants did: the lease card localised the building beside a unit rendered
 * from `name` unconditionally, so an English session read "Danat Tower" and
 * "محل تجريبي" side by side. Every unit in production carries a real
 * `name_en`, so the value was there and simply never asked for.
 *
 * The code is the last resort. `name` is NOT NULL, so the portal's old
 * `unit.name ?? unit.code` could never fall through — but an empty string
 * would have reached the tenant as a blank field with no identifier to quote
 * to the office.
 */
export function unitDisplayName(unit: NamedUnit & { code: string }, locale: Locale): string {
  const name = locale === "en" ? unit.name_en?.trim() || unit.name : unit.name;
  return name || unit.code;
}
