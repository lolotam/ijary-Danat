import { Sparkles } from "lucide-react";

import type { LandingMedia } from "@/hooks/useLandingSettings";
import { useI18n } from "@/i18n/provider";
import { gridColsClass, PAGE_SHELL } from "./landingLayout";

interface GallerySectionProps {
  galleryItems: LandingMedia[];
  galleryColumns: number;
  setLightboxIndex: (index: number) => void;
}

/**
 * شبكة معرض الصور؛ النقر يفتح العارض بملء الشاشة.
 *
 * The grid and the lightbox read the same `galleryItems` list from the page,
 * so an index here is always the right index there.
 */
export function GallerySection({
  galleryItems,
  galleryColumns,
  setLightboxIndex,
}: GallerySectionProps) {
  const { t, locale } = useI18n();

  return (
    <section id="gallery" className="bg-card border-y border-border py-24 scroll-mt-20">
      <div className="text-center max-w-3xl mx-auto mb-16 px-4">
        <span className="flex items-center justify-center gap-2 text-xs font-semibold tracking-[0.14em] text-gold-deep">
          <Sparkles className="size-3.5" />
          {t("landingPage.portfolio")}
        </span>
        <h2 className="text-3xl sm:text-4xl font-extrabold text-foreground mt-2 mb-4">
          {t("landing.gallery.title")}
        </h2>
        <div className="w-12 h-1 bg-gradient-to-r from-accent/80 to-accent mx-auto mb-6" />
      </div>

      <div className={PAGE_SHELL}>
        <div className={`grid gap-3 sm:gap-4 ${gridColsClass(galleryColumns)}`}>
          {galleryItems.map((media, idx) => (
            <button
              type="button"
              key={media.id}
              onClick={() => setLightboxIndex(idx)}
              aria-label={
                (locale === "ar" ? media.alt_ar : media.alt_en) ||
                t("landingPage.openPhotoNumber").replace("{n}", String(idx + 1))
              }
              className="aspect-[4/3] rounded-xl overflow-hidden border border-border relative group cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <img
                src={media.storage_path}
                alt={locale === "ar" ? media.alt_ar || "" : media.alt_en || ""}
                loading="lazy"
                className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105 motion-reduce:transition-none motion-reduce:group-hover:scale-100"
              />
              <div className="absolute inset-0 bg-[#050505]/60 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity flex items-center justify-center text-xs font-bold text-[#F2CD60]">
                <span>{t("landingPage.openLightbox")}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
