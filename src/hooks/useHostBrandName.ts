import { useLoaderData } from "@tanstack/react-router";

import { brandNameFor, PLATFORM_BRANDING, type PublicBranding } from "@/fns/publicBranding";
import { useI18n } from "@/i18n/provider";

/**
 * يعيد اسم الشركة المالكة للمضيف بلغة العرض الحالية، أو اسم المنصة على مضيف بلا شركة.
 *
 * Headers, sidebars and footers used to print a fixed Danat name for every
 * company. The root route already resolves the host's public branding once per
 * request, so this reads the root loader data instead of fetching again.
 */
export function useHostBrandName(): string {
  const { locale } = useI18n();
  const { branding } = useLoaderData({ from: "__root__" }) as {
    branding?: PublicBranding | null;
  };
  return brandNameFor(branding ?? PLATFORM_BRANDING, locale);
}
