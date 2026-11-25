import { createServerFn } from "@tanstack/react-start";

import { supabaseAdmin } from "@/integrations/supabase/client.server";

export interface PublicBranding {
  logoUrl: string | null;
  faviconUrl: string | null;
  portalBgUrl: string | null;
  emailLogoUrl: string | null;
}

/**
 * شعار البريد: الشعار المخصّص للبريد، وإلا شعار التطبيق، وإلا لا شيء.
 *
 * Null is the fallback, not an error: an installation that never uploaded an
 * email logo should still send mail, just without one.
 */
export function emailLogoFor(branding: PublicBranding | null): string | null {
  return branding?.emailLogoUrl ?? branding?.logoUrl ?? null;
}

let cache: { value: PublicBranding; expiresAt: number } | null = null;
const CACHE_TTL_MS = 60 * 1000;

/**
 * يقرأ هوية الشركة: الشعار والأيقونة وخلفية البوابة وشعار البريد.
 *
 * Company branding for the document head, the public pages (landing, auth,
 * portal) and outgoing email. Read with the service role because anonymous
 * visitors have no RLS access to `companies`; only these four display columns
 * are exposed. Cached for a minute so every SSR request doesn't hit the
 * database.
 *
 * Server-side callers use this rather than `getPublicBranding()`: a server fn
 * calling another server fn is needless indirection, and it breaks under the
 * shared `createServerFn` mock the src/fns tests use, where every server fn
 * collapses to the same object and the inner call re-enters the outer handler.
 */
export async function readPublicBranding(): Promise<PublicBranding> {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  try {
    const { data } = await supabaseAdmin
      .from("companies")
      .select("logo_url, favicon_url, portal_bg_url, email_logo_url")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    const value: PublicBranding = {
      logoUrl: data?.logo_url ?? null,
      faviconUrl: (data as { favicon_url?: string | null } | null)?.favicon_url ?? null,
      portalBgUrl: (data as { portal_bg_url?: string | null } | null)?.portal_bg_url ?? null,
      emailLogoUrl: (data as { email_logo_url?: string | null } | null)?.email_logo_url ?? null,
    };
    cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
    return value;
  } catch {
    return { logoUrl: null, faviconUrl: null, portalBgUrl: null, emailLogoUrl: null };
  }
}

/** Route-loader entry point for the same read. */
export const getPublicBranding = createServerFn({ method: "GET" }).handler(
  async (): Promise<PublicBranding> => readPublicBranding(),
);
