import { useEffect, useState } from "react";

import type { CarouselApi } from "@/components/ui/carousel";
import { type Locale, translatorFor } from "@/i18n/dictionary";

type CarouselDotsProps = {
  /** واجهة الكاروسيل، وتكون null حتى ينتهي التركيب الأول. */
  api: CarouselApi | null;
  /** عدد الشرائح، أي عدد النقاط المعروضة. */
  count: number;
  /** اللغة النشطة، لصياغة تسمية كل نقطة. */
  locale: Locale;
};

/**
 * يعرض نقاط التنقّل بين شرائح الكاروسيل ويُبرز النقطة النشطة.
 *
 * The active index lives here rather than in the page component on purpose:
 * the carousel auto-advances every five seconds, and holding this index any
 * higher re-rendered the whole landing page twelve times a minute, forever,
 * just to recolour these dots.
 */
export function CarouselDots({ api, count, locale }: CarouselDotsProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const t = translatorFor(locale);

  useEffect(() => {
    if (!api) return;

    /** يقرأ الشريحة النشطة الحالية من الكاروسيل ويحدّث النقطة المميّزة. */
    const syncFromApi = () => setActiveIndex(api.selectedScrollSnap());

    // Seed before subscribing: an api handed over mid-cycle is already past
    // slide 0, and waiting for the next `select` would show a stale dot.
    syncFromApi();

    // `reInit` as well as `select`, matching src/components/ui/carousel.tsx —
    // embla re-initialises when the slide set changes and does not reliably
    // emit `select` afterwards, which would leave every dot inactive once the
    // slides query refetches.
    api.on("select", syncFromApi);
    api.on("reInit", syncFromApi);

    return () => {
      api.off("select", syncFromApi);
      api.off("reInit", syncFromApi);
    };
  }, [api]);

  return (
    <div className="flex gap-1">
      {Array.from({ length: count }, (_, idx) => (
        <button
          type="button"
          key={idx}
          onClick={() => api?.scrollTo(idx)}
          aria-label={t("landing.slideLabel").replace("{n}", String(idx + 1))}
          aria-current={idx === activeIndex}
          className="py-2 px-0.5 cursor-pointer"
        >
          <span
            className={`block h-1.5 rounded-full transition-all duration-300 ${
              idx === activeIndex ? "w-8 bg-accent" : "w-2 bg-muted"
            }`}
          />
        </button>
      ))}
    </div>
  );
}
