import { Store } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { LinkedBrand } from "@/hooks/useLinkedBrand";
import { useI18n } from "@/i18n/provider";

/**
 * Storefront linked to a contract, shown on the tenant, unit and portal pages.
 * Renders nothing when no brand is linked, so callers can drop it in freely.
 */
export function StoreLogoCard({
  brand,
  tenantName,
}: {
  brand: LinkedBrand | null | undefined;
  tenantName?: string | null;
}) {
  const { t, locale } = useI18n();
  if (!brand) return null;
  const name = locale === "ar" ? brand.name_ar : (brand.name_en ?? brand.name_ar);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Store className="size-4 text-primary" />
          {t("store.linked")}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex items-center gap-4">
        {brand.logoUrl ? (
          <img
            src={brand.logoUrl}
            alt={name}
            className="aspect-video w-32 shrink-0 rounded-lg border bg-muted/40 object-contain p-2"
          />
        ) : (
          <div className="grid aspect-video w-32 shrink-0 place-items-center rounded-lg border bg-muted/40">
            <Store className="size-6 text-muted-foreground" />
          </div>
        )}
        <div className="min-w-0">
          <p className="truncate font-semibold">{name}</p>
          {tenantName ? (
            <p className="truncate text-sm text-muted-foreground">
              {t("store.contractedBy")}: {tenantName}
            </p>
          ) : null}
          <a
            href={`/#shops`}
            className="text-xs text-primary underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("store.viewOnLanding")}
          </a>
        </div>
      </CardContent>
    </Card>
  );
}
