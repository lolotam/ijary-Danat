import { useEffect, useState } from "react";
import { ArrowRight, Sparkles } from "lucide-react";

import { CarouselDots } from "@/components/landing/CarouselDots";
import { Button } from "@/components/ui/button";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  type CarouselApi,
} from "@/components/ui/carousel";
import type { LandingCarouselSlide } from "@/hooks/useLandingSettings";
import { useI18n } from "@/i18n/provider";
import { PAGE_SHELL } from "./landingLayout";

interface MidpointSliderProps {
  slides: LandingCarouselSlide[];
}

/**
 * شرائح العرض 16:9 في منتصف الصفحة مع التشغيل التلقائي.
 *
 * Autoplay pauses on hover, drag and keyboard focus, and never runs under
 * prefers-reduced-motion — all of that state belongs to this carousel only.
 */
export function MidpointSlider({ slides }: MidpointSliderProps) {
  const { t, locale, dir } = useI18n();
  const [carouselApi, setCarouselApi] = useState<CarouselApi | null>(null);
  const [carouselHoverActive, setCarouselHoverActive] = useState(false);
  const [carouselDragActive, setCarouselDragActive] = useState(false);
  const [carouselFocusActive, setCarouselFocusActive] = useState(false);

  useEffect(() => {
    if (
      !carouselApi ||
      carouselHoverActive ||
      carouselDragActive ||
      carouselFocusActive ||
      (slides?.length ?? 0) < 2
    )
      return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") carouselApi.scrollNext();
    }, 5000);

    return () => window.clearInterval(timer);
  }, [carouselApi, carouselDragActive, carouselFocusActive, carouselHoverActive, slides?.length]);

  useEffect(() => {
    if (!carouselDragActive) return;
    const stopDragging = () => setCarouselDragActive(false);
    window.addEventListener("pointerup", stopDragging, { once: true });
    window.addEventListener("pointercancel", stopDragging, { once: true });
    return () => {
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("pointercancel", stopDragging);
    };
  }, [carouselDragActive]);

  return (
    <section className="bg-card border-y border-border py-24 relative overflow-hidden">
      <div className={PAGE_SHELL}>
        <Carousel
          className="w-full relative"
          opts={{ loop: true, direction: dir }}
          setApi={setCarouselApi}
          onPointerEnter={() => setCarouselHoverActive(true)}
          onPointerLeave={() => setCarouselHoverActive(false)}
          onPointerDown={() => setCarouselDragActive(true)}
          onFocusCapture={() => setCarouselFocusActive(true)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setCarouselFocusActive(false);
          }}
        >
          <CarouselContent>
            {slides.map((slide) => (
              <CarouselItem key={slide.id}>
                <div className="grid md:grid-cols-2 items-center gap-8 md:gap-16">
                  <div className="aspect-video w-full rounded-2xl overflow-hidden border border-border shadow-2xl">
                    <picture>
                      {(slide as any).mobile_media?.storage_path ? (
                        <source
                          media="(max-width: 767px)"
                          srcSet={(slide as any).mobile_media.storage_path}
                        />
                      ) : null}
                      <img
                        src={(slide as any).media?.storage_path || "/landing/hero.png"}
                        alt={locale === "ar" ? slide.title_ar : slide.title_en}
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-cover"
                      />
                    </picture>
                  </div>
                  <div className="space-y-6">
                    <span className="flex items-center gap-2 text-xs font-semibold tracking-[0.14em] text-gold-deep">
                      <Sparkles className="size-3.5" />
                      {t("landingPage.lifestyleExperience")}
                    </span>
                    <h3 className="text-3xl font-bold leading-tight text-foreground sm:text-5xl">
                      {locale === "ar" ? slide.title_ar : slide.title_en}
                    </h3>
                    <p className="text-muted-foreground text-base sm:text-lg leading-relaxed font-medium">
                      {locale === "ar" ? slide.description_ar : slide.description_en}
                    </p>
                    {slide.cta_url && (
                      <Button
                        asChild
                        size="lg"
                        className="bg-[#d4af37] px-8 font-bold text-[#171204]"
                      >
                        <a href={slide.cta_url}>
                          {locale === "ar" ? slide.cta_label_ar : slide.cta_label_en}
                          <ArrowRight className="h-4 w-4 ms-2 inline rtl:rotate-180" />
                        </a>
                      </Button>
                    )}
                  </div>
                </div>
              </CarouselItem>
            ))}
          </CarouselContent>
          {/* Manual Arrow Controls */}
          <div className="absolute bottom-[-50px] left-1/2 -translate-x-1/2 flex items-center gap-6 mt-6">
            <CarouselPrevious className="relative translate-x-0 translate-y-0 bg-muted border-border text-accent hover:bg-accent hover:text-[#050505] rounded-full h-10 w-10" />
            <CarouselDots api={carouselApi} count={slides.length} locale={locale} />
            <CarouselNext className="relative translate-x-0 translate-y-0 bg-muted border-border text-accent hover:bg-accent hover:text-[#050505] rounded-full h-10 w-10" />
          </div>
        </Carousel>
      </div>
    </section>
  );
}
