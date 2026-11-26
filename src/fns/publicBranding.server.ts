import { companyClient } from "@/company/companyClient.server";
import { getRequestCompany } from "@/company/requestCompany.server";
import type { PublicBranding } from "@/fns/publicBranding";

const EMPTY_BRANDING: PublicBranding = {
  logoUrl: null,
  faviconUrl: null,
  portalBgUrl: null,
  emailLogoUrl: null,
};

const cacheByCompany = new Map<string, { value: PublicBranding; expiresAt: number }>();
const CACHE_TTL_MS = 60 * 1000;

/**
 * يقرأ هوية شركة الطلب الحالية: الشعار والأيقونة وخلفية البوابة وشعار البريد.
 *
 * Scoped to `getRequestCompany()` and cached per company ID so SSR branding
 * never crosses company boundaries. Returns empty branding when the request
 * has no company host (platform root / admin host).
 *
 * Lives in a `.server.ts` file because a plain export next to a server function
 * stays in the browser bundle, and with it the Node-only company context.
 */
export async function readPublicBranding(): Promise<PublicBranding> {
  const company = getRequestCompany();
  if (!company) return { ...EMPTY_BRANDING };

  const cached = cacheByCompany.get(company.id);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const db = companyClient(company.id);
    const { data } = await db
      .from("companies")
      .select("logo_url, favicon_url, portal_bg_url, email_logo_url")
      .eq("id", company.id)
      .maybeSingle();
    const value: PublicBranding = {
      logoUrl: data?.logo_url ?? null,
      faviconUrl: (data as { favicon_url?: string | null } | null)?.favicon_url ?? null,
      portalBgUrl: (data as { portal_bg_url?: string | null } | null)?.portal_bg_url ?? null,
      emailLogoUrl: (data as { email_logo_url?: string | null } | null)?.email_logo_url ?? null,
    };
    cacheByCompany.set(company.id, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  } catch {
    return { ...EMPTY_BRANDING };
  }
}

/** يفرّغ ذاكرة الهوية العامة المؤقتة (مفيد في الاختبارات). */
export function clearPublicBrandingCache(): void {
  cacheByCompany.clear();
}
