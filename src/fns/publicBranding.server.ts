import { companyClient } from "@/company/companyClient.server";
import { getRequestCompany } from "@/company/requestCompany.server";
import { PLATFORM_BRANDING, type PublicBranding } from "@/fns/publicBranding";

const cacheByCompany = new Map<string, { value: PublicBranding; expiresAt: number }>();
const CACHE_TTL_MS = 60 * 1000;

/**
 * يقرأ هوية شركة الطلب الحالية: الاسم والشعار والألوان وخلفية البوابة وشعار البريد.
 *
 * Scoped to `getRequestCompany()` and cached per company ID so SSR branding
 * never crosses company boundaries. A host without a company (platform root,
 * super admin host) gets the platform branding. A database failure throws
 * instead of quietly demoting the company to the platform identity — a sign-in
 * page that names the wrong company is worse than an error page.
 *
 * Lives in a `.server.ts` file because a plain export next to a server function
 * stays in the browser bundle, and with it the Node-only company context.
 */
export async function readPublicBranding(): Promise<PublicBranding> {
  const company = getRequestCompany();
  if (!company) return PLATFORM_BRANDING;

  const cached = cacheByCompany.get(company.id);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const db = companyClient(company.id);
  const { data, error } = await db
    .from("companies")
    .select(
      "name_ar, name_en, brand_primary, brand_accent, logo_url, favicon_url, portal_bg_url, email_logo_url",
    )
    .eq("id", company.id)
    .maybeSingle();
  if (error) throw new Error(`readPublicBranding(${company.id}) failed: ${error.message}`);
  if (!data) throw new Error(`readPublicBranding: company ${company.id} not found`);

  const value: PublicBranding = {
    nameAr: data.name_ar,
    nameEn: data.name_en,
    brandPrimary: data.brand_primary ?? null,
    brandAccent: data.brand_accent ?? null,
    logoUrl: data.logo_url ?? null,
    faviconUrl: data.favicon_url ?? null,
    portalBgUrl: data.portal_bg_url ?? null,
    emailLogoUrl: data.email_logo_url ?? null,
  };
  cacheByCompany.set(company.id, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** يفرّغ ذاكرة الهوية العامة المؤقتة (مفيد في الاختبارات). */
export function clearPublicBrandingCache(): void {
  cacheByCompany.clear();
}
