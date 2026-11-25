import { Edit2, Image as ImageIcon, Trash2 } from "lucide-react";

import { PreviewableImage } from "@/components/admin/ImagePreviewDialog";
import { CardActionsMenu } from "@/components/admin/landing-page/CardActionsMenu";
import { Card, CardContent } from "@/components/ui/card";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import type { LandingCarouselSlide } from "@/hooks/useLandingSettings";
import { useI18n } from "@/i18n/provider";

export type SlideRow = LandingCarouselSlide & {
  media?: { storage_path: string } | null;
  mobile_media?: { storage_path: string } | null;
};

/**
 * شبكة بطاقات شرائح العرض في إعدادات صفحة الهبوط.
 *
 * Extracted from admin.settings.landing-page.tsx so the parent stays under the
 * file-size ceiling; edit/delete still call the same parent handlers.
 */
export function SlidesTable({
  slides,
  onEditSlide,
  onDeleteSlide,
}: {
  slides: SlideRow[] | undefined;
  onEditSlide: (slide: SlideRow) => void;
  onDeleteSlide: (id: string) => void;
}) {
  const { t, locale } = useI18n();

  // `slides` is undefined while loading and [] when empty — gating on
  // falsy-or-empty would flash the empty state on every page load.
  if (Array.isArray(slides) && slides.length === 0) {
    return (
      <EmptyState
        icon={ImageIcon}
        title={t("slidesTable.noSlidesYet")}
        description={t("slidesTable.clickAddSlideToShow")}
      />
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {slides?.map((slide, index) => (
        <SlideCard
          key={slide.id}
          slide={slide}
          index={index}
          onEditSlide={onEditSlide}
          onDeleteSlide={onDeleteSlide}
        />
      ))}
    </div>
  );
}

/**
 * بطاقة شريحة واحدة: الصورة والحقول وإجراءات التعديل والحذف كما في صف الجدول.
 */
function SlideCard({
  slide,
  index,
  onEditSlide,
  onDeleteSlide,
}: {
  slide: SlideRow;
  index: number;
  onEditSlide: (slide: SlideRow) => void;
  onDeleteSlide: (id: string) => void;
}) {
  const { t, locale } = useI18n();
  const thumb = slide.media?.storage_path;
  const title = locale === "ar" ? slide.title_ar : slide.title_en;

  return (
    <Card className="relative overflow-hidden">
      <CardActionsMenu label={t("slidesTable.actions")}>
        <DropdownMenuItem onSelect={() => onEditSlide(slide)}>
          <Edit2 className="size-4" />
          {t("common.edit")}
        </DropdownMenuItem>
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={() => onDeleteSlide(slide.id)}
        >
          <Trash2 className="size-4" />
          {t("common.delete")}
        </DropdownMenuItem>
      </CardActionsMenu>
      {thumb ? (
        <PreviewableImage
          url={thumb}
          alt={title}
          className="rounded-none border-0 border-b"
          imageClassName="aspect-video w-full object-cover"
        />
      ) : (
        <div className="flex aspect-video items-center justify-center border-b bg-muted/30">
          <ImageIcon className="size-6 text-muted-foreground" />
        </div>
      )}
      <CardContent className="space-y-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-semibold leading-tight">{title}</h3>
          <span className="text-xs font-medium text-muted-foreground tabular-nums">
            {index + 1}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{slide.cta_url}</p>
        <div className="flex items-center justify-between text-xs">
          <span>{slide.display_order}</span>
          <span>{slide.is_active ? t("slidesTable.active") : t("slidesTable.off")}</span>
        </div>
      </CardContent>
    </Card>
  );
}
