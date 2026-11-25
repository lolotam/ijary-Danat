import { useRef } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useI18n } from "@/i18n/provider";
import { SHOP_IMAGE_FIELDS, type ShopImageKind } from "@/lib/shopImageFields";
import { SHOP_IMAGE_ACCEPT } from "@/lib/shopMediaUpload";
import type { ShopImageUpload } from "@/hooks/useShopImageUpload";

export interface ShopImageFieldProps {
  /** أي صورة من صورتي المتجر — منها تُشتق النسبة والنصوص. */
  kind: ShopImageKind;
  /** حالة الرفع القادمة من `useShopImageUpload`. */
  image: ShopImageUpload;
}

/**
 * يعرض حقل صورة واحد في لوحة «متجري»: النسبة معلنة، والمربّع نفسه بتلك النسبة.
 *
 * The placeholder is not a generic grey strip. It is a box of the aspect ratio
 * this image is published at, so the tenant reads the shape before choosing a
 * file, and the preview after choosing shows the same crop the landing page
 * will apply — `object-contain` letterboxes the carousel logo, `object-cover`
 * trims the explorer card. Seeing the crop here is the whole point; the
 * alternative is discovering it on the public site.
 */
export function ShopImageField({ kind, image }: ShopImageFieldProps) {
  const { t } = useI18n();
  const field = SHOP_IMAGE_FIELDS[kind];
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-2">
      <Label className="flex flex-wrap items-center gap-2">
        {t(field.labelKey)}
        <span className="rounded border px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
          {field.ratioLabel}
        </span>
      </Label>
      <p className="text-xs text-muted-foreground">{t(field.hintKey)}</p>

      <div
        className={`w-full max-w-xs overflow-hidden rounded border bg-muted/30 ${field.boxClassName}`}
      >
        {image.previewUrl ? (
          <img src={image.previewUrl} alt="" className={`h-full w-full ${field.fitClassName}`} />
        ) : (
          <div className="flex h-full w-full items-center justify-center px-2 text-center text-xs text-muted-foreground">
            {t(field.emptyKey)}
          </div>
        )}
      </div>

      <div className="flex gap-2">
        <Input
          ref={inputRef}
          type="file"
          accept={SHOP_IMAGE_ACCEPT}
          className="hidden"
          onChange={async (event) => {
            await image.pick(event.target.files?.[0]);
            // Clear the input so re-picking the same file fires change again —
            // a failed upload otherwise cannot be retried with that file.
            if (inputRef.current) inputRef.current.value = "";
          }}
        />
        <Button
          type="button"
          variant="outline"
          disabled={image.uploading}
          onClick={() => inputRef.current?.click()}
        >
          {image.uploading ? t("portal.shop.saving") : t("portal.shop.upload")}
        </Button>
        {image.mediaId || image.previewUrl ? (
          <Button type="button" variant="ghost" onClick={image.clear}>
            {t("portal.shop.removeImage")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
