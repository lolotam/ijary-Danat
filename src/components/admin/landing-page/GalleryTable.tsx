import { Check, Images, Trash2 } from "lucide-react";

import { PreviewableImage } from "@/components/admin/ImagePreviewDialog";
import { CardActionsMenu } from "@/components/admin/landing-page/CardActionsMenu";
import { Card, CardContent } from "@/components/ui/card";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import type { LandingMedia } from "@/hooks/useLandingSettings";
import { useI18n } from "@/i18n/provider";

/**
 * شبكة بطاقات معرض الصور في إعدادات صفحة الهبوط.
 *
 * Extracted from admin.settings.landing-page.tsx. The menu holds the same
 * show-in-gallery toggle and the delete action only for category === "gallery".
 */
export function GalleryTable({
  items,
  onToggleGalleryItem,
  onDeleteMedia,
}: {
  items: LandingMedia[];
  onToggleGalleryItem: (id: string, show: boolean) => void;
  onDeleteMedia: (id: string) => void;
}) {
  const { t, locale } = useI18n();

  if (items.length === 0) {
    // The copy is the block this component rendered before EmptyState existed,
    // moved verbatim — "migrated" was the requirement, not "reworded".
    return <EmptyState icon={Images} title={t("galleryTable.noGalleryImagesYetClick")} />;
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((media, index) => (
        <GalleryCard
          key={media.id}
          media={media}
          index={index}
          onToggleGalleryItem={onToggleGalleryItem}
          onDeleteMedia={onDeleteMedia}
        />
      ))}
    </div>
  );
}

/**
 * بطاقة صورة معرض: المعاينة ومصدر الفئة والترتيب ومبدّل الظهور كما في الصف.
 */
function GalleryCard({
  media,
  index,
  onToggleGalleryItem,
  onDeleteMedia,
}: {
  media: LandingMedia;
  index: number;
  onToggleGalleryItem: (id: string, show: boolean) => void;
  onDeleteMedia: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  const imageUrl = media.storage_path?.trim();
  // `is_active` is a different question from "is this flagged for the gallery",
  // and folding it in here made the flag unreachable: an inactive-but-flagged row
  // computed `shown === false`, so the menu only ever offered to switch it ON.
  const shown = !!media.show_in_gallery;
  const hiddenByInactive = shown && media.is_active === false;
  const previewAlt = locale === "ar" ? (media.alt_ar ?? "") : (media.alt_en ?? "");

  return (
    <Card className="relative overflow-hidden">
      <CardActionsMenu label={t("galleryTable.actions")}>
        <DropdownMenuItem onSelect={() => onToggleGalleryItem(media.id, !shown)}>
          {shown ? <Check className="size-4" /> : <span className="size-4" />}
          {t("galleryTable.inGallery")}
        </DropdownMenuItem>
        {media.category === "gallery" ? (
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onSelect={() => onDeleteMedia(media.id)}
          >
            <Trash2 className="size-4" />
            {t("common.delete")}
          </DropdownMenuItem>
        ) : null}
      </CardActionsMenu>
      {imageUrl ? (
        <PreviewableImage
          url={imageUrl}
          alt={previewAlt}
          className="rounded-none border-0 border-b"
          imageClassName="aspect-video w-full object-cover"
        />
      ) : null}
      <CardContent className="space-y-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs capitalize">{media.category}</p>
          <span className="text-xs font-medium text-muted-foreground tabular-nums">
            {index + 1}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{media.display_order}</p>
        {hiddenByInactive ? (
          <p className="text-xs text-muted-foreground">{t("galleryTable.hiddenItemInactive")}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
