/**
 * اسم الطرف الذي يُطبع على الفواتير والإيصالات: الاسم التجاري أولاً، بلغة المستند.
 *
 * One helper for print, download and email so the three cannot drift.
 * `tenants.name` is the live Arabic column; `name_ar` is accepted so the
 * same helper works with the brief's fixture shape and with real rows.
 */

export type PartyNameTenant = {
  /** Migration 140. */
  commercial_name_ar?: string | null;
  /** Migration 140. */
  commercial_name_en?: string | null;
  /** Pre-140 single-language column, kept as a derived mirror of the pair. */
  commercial_name?: string | null;
  name?: string | null;
  name_ar?: string | null;
  name_en?: string | null;
};

/** Trims and treats a whitespace-only value as absent. */
function present(value: string | null | undefined): string {
  return value?.trim() || "";
}

/**
 * يختار الاسم التجاري بلغة المستند، وإلا اسم المستأجر حسب اللغة.
 *
 * Order within each locale: the commercial name in that language, then the
 * commercial name in the other one, then the personal name. A commercial party
 * stays a commercial party — falling straight from a missing English trade name
 * to the tenant's personal name would put a different legal entity on the
 * document, which is worse than showing the Arabic trade name to an English
 * reader.
 *
 * `commercial_name` is the pre-140 column and is consulted last among the
 * commercial ones, for rows read through a select that has not been widened
 * yet. Whitespace-only values are treated as missing: a truthy "   " would
 * otherwise print a blank party on a real receipt.
 */
export function resolvePartyName(tenant: PartyNameTenant, locale: "ar" | "en"): string {
  const commercialAr = present(tenant.commercial_name_ar);
  const commercialEn = present(tenant.commercial_name_en);
  const legacyCommercial = present(tenant.commercial_name);
  const arabic = present(tenant.name ?? tenant.name_ar);
  const english = present(tenant.name_en);

  if (locale === "en") {
    return commercialEn || commercialAr || legacyCommercial || english || arabic;
  }
  return commercialAr || commercialEn || legacyCommercial || arabic || english;
}
