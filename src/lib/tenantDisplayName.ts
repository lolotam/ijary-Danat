import type { Locale } from "@/i18n/dictionary";

/**
 * Tenant name for the current UI language.
 *
 * `tenants.name` is the primary (Arabic) name and is always present;
 * `name_en` is optional, so English falls back to it rather than rendering
 * an empty cell — the same rule properties use for name_ar/name_en.
 *
 * Use on UI screens that follow the page language (admin + tenant portal)
 * and on tenant-facing notifications that already pick a locale
 * (`sendCompanyInfo` greets in that language).
 */
export function tenantDisplayName(
  tenant: { name: string; name_en?: string | null },
  locale: Locale,
): string {
  return locale === "en" ? tenant.name_en?.trim() || tenant.name : tenant.name;
}

/**
 * هل انتهى عقد المستأجر: الشرط الوحيد الذي يُظهر شارة "انتهى العقد" في القوائم.
 *
 * `lifecycle` is derived server-side (migration 54) from active contracts
 * alone, so the dropdowns must read it rather than recompute it from a
 * contracts list — the lists that only hold `{id, name, code}` must first be
 * widened to carry `lifecycle` (see `ContractedTenant`, `GrantRoleDialog`
 * tenant options, `WhatsAppTenantOption`).
 */
export function isContractEnded(tenant: { lifecycle: string }): boolean {
  return tenant.lifecycle === "contract_ended";
}
