import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

import type { LandingMedia } from "@/hooks/useLandingSettings";
import { useI18n } from "@/i18n/provider";

interface GalleryLightboxProps {
  galleryItems: LandingMedia[];
  lightboxIndex: number;
  setLightboxIndex: Dispatch<SetStateAction<number | null>>;
}

/**
 * عارض الصور بملء الشاشة مع التنقل بلوحة المفاتيح وحبس التركيز.
 *
 * Mounted only while a photo is open, so the keyboard handler and the focus
 * trap exist exactly as long as the overlay does.
 */
export function GalleryLightbox({
  galleryItems,
  lightboxIndex,
  setLightboxIndex,
}: GalleryLightboxProps) {
  const { t, locale } = useI18n();
  const lightboxRef = useRef<HTMLDivElement>(null);

  // Keyboard navigation + focus trap for the lightbox
  const lightboxOpen = lightboxIndex !== null;
  useEffect(() => {
    if (!lightboxOpen || galleryItems.length === 0) return;

    lightboxRef.current?.querySelector("button")?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") {
        setLightboxIndex((prev) => (prev! + 1) % galleryItems.length);
      } else if (e.key === "ArrowLeft") {
        setLightboxIndex((prev) => (prev! - 1 + galleryItems.length) % galleryItems.length);
      } else if (e.key === "Escape") {
        setLightboxIndex(null);
      } else if (e.key === "Tab") {
        const focusables = lightboxRef.current?.querySelectorAll<HTMLButtonElement>("button");
        if (!focusables || focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [lightboxOpen, galleryItems.length, setLightboxIndex]);

  return (
    <div
      ref={lightboxRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("landingPage.photoLightbox")}
      onClick={() => setLightboxIndex(null)}
      className="fixed inset-0 z-50 bg-[#050505]/98 flex flex-col items-center justify-center animate-fade-in motion-reduce:animate-none"
    >
      <button
        onClick={() => setLightboxIndex(null)}
        title={t("landingPage.close")}
        aria-label={t("landingPage.close")}
        className="absolute top-[calc(1.5rem+env(safe-area-inset-top))] end-6 p-3 rounded-full bg-[#191919] hover:bg-[#F2CD60] hover:text-[#050505] text-[#F2CD60] transition-colors"
      >
        <X className="h-6 w-6" />
      </button>

      <div
        className="relative max-w-4xl w-full px-6 flex items-center justify-between"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={() =>
            setLightboxIndex((prev) => (prev! - 1 + galleryItems.length) % galleryItems.length)
          }
          title={t("landingPage.previousPhoto")}
          aria-label={t("landingPage.previousPhoto")}
          className="p-3 rounded-full bg-[#191919] text-[#F2CD60] hover:bg-[#F2CD60] hover:text-[#050505] transition-colors"
        >
          <ChevronLeft className="h-6 w-6 rtl:rotate-180" />
        </button>

        <div className="flex flex-col items-center gap-4 max-w-[80vw]">
          <img
            src={galleryItems[lightboxIndex].storage_path}
            alt={
              locale === "ar"
                ? galleryItems[lightboxIndex].alt_ar || ""
                : galleryItems[lightboxIndex].alt_en || ""
            }
            decoding="async"
            fetchPriority="high"
            className="max-h-[70vh] rounded-xl object-contain border border-[#191919] shadow-2xl"
          />
          <p className="text-sm font-bold text-white text-center" aria-live="polite">
            {locale === "ar"
              ? galleryItems[lightboxIndex].caption_ar
              : galleryItems[lightboxIndex].caption_en}
            <span className="block text-xs text-[#D6D0C5]/60 mt-1" dir="ltr">
              {lightboxIndex + 1} / {galleryItems.length}
            </span>
          </p>
        </div>

        <button
          onClick={() => setLightboxIndex((prev) => (prev! + 1) % galleryItems.length)}
          title={t("landingPage.nextPhoto")}
          aria-label={t("landingPage.nextPhoto")}
          className="p-3 rounded-full bg-[#191919] text-[#F2CD60] hover:bg-[#F2CD60] hover:text-[#050505] transition-colors"
        >
          <ChevronRight className="h-6 w-6 rtl:rotate-180" />
        </button>
      </div>
    </div>
  );
}
