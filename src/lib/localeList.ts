import type { Locale } from "@/i18n/dictionary";

/**
 * Joins a list of names with the separator its language actually uses.
 *
 * Arabic separates with the comma `،` (U+060C); English with `,`. The portal
 * had `join("، ")` hardcoded at every site, so an English session read
 * "Test Unit، Shop 2" — the names localised correctly and then were stitched
 * together with punctuation from the other language.
 *
 * Empty entries are dropped rather than producing a dangling separator, which
 * is why callers can pass a mapped list without filtering it first.
 */
export function joinLocalized(values: ReadonlyArray<string>, locale: Locale): string {
  return values.filter((value) => value.trim()).join(locale === "ar" ? "، " : ", ");
}
