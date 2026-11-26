import { createServerFn } from "@tanstack/react-start";

import { companyClient } from "@/company/companyClient.server";
import { getRequestCompany } from "@/company/requestCompany.server";

export interface PublicBranding {
  logoUrl: string | null;
  faviconUrl: string | null;
  portalBgUrl: string | null;
  emailLogoUrl: string | null;
}

const EMPTY_BRANDING: PublicBranding = {
  logoUrl: null,
  faviconUrl: null,
  portalBgUrl: null,
  emailLogoUrl: null,
};

/**
 * شعار البريد: الشعار المخصّص للبريد، وإلا شعار التطبيق، وإلا لا شيء.
 *
 * Null is the fallback, not an error: an installation that never uploaded an
 * email logo should still send mail, just without one.
 */
export function emailLogoFor(branding: PublicBranding | null): string | null {
  return branding?.emailLogoUrl ?? branding?.logoUrl ?? null;
}

const cacheByCompany = new Map<string, { value: PublicBranding; expiresAt: number }>();
const CACHE_TTL_MS = 60 * 1000;

/**
 * يقرأ هوية شركة الطلب الحالية: الشعار والأيقونة وخلفية البوابة وشعار البريد.
 *
 * Scoped to `getRequestCompany()` and cached per company ID so SSR branding
 * never crosses company boundaries. Returns empty branding when the request
 * has no company host (platform root / admin host).
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

/** نقطة دخول محمّل المسار لقراءة هوية الشركة العامة. */
export const getPublicBranding = createServerFn({ method: "GET" }).handler(
  async (): Promise<PublicBranding> => readPublicBranding(),
);
