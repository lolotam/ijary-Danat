import { createServerFn } from "@tanstack/react-start";

import { readPublicBranding } from "@/fns/publicBranding.server";

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

/** نقطة دخول محمّل المسار لقراءة هوية الشركة العامة. */
export const getPublicBranding = createServerFn({ method: "GET" }).handler(
  async (): Promise<PublicBranding> => readPublicBranding(),
);
