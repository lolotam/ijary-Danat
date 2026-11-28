import { ArrowRight, MapPin, Sparkles } from "lucide-react";

import { HeroTitle } from "@/components/landing/HeroTitle";
import { TypedText } from "@/components/landing/TypedText";
import { Button } from "@/components/ui/button";
import { useHostBrandName } from "@/hooks/useHostBrandName";
import type { LandingPageSettingsWithMedia } from "@/hooks/useLandingSettings";
import { useI18n } from "@/i18n/provider";

interface HeroSectionProps {
  settings: LandingPageSettingsWithMedia | null | undefined;
  isSectionEnabled: (key: string) => boolean;
}

/**
 * قسم الواجهة بملء الشاشة: الصورة الخلفية والعنوان المكتوب وأزرار الانتقال.
 */
export function HeroSection({ settings, isSectionEnabled }: HeroSectionProps) {
  const { t } = useI18n();
  const companyName = useHostBrandName();

  // Hero headings type themselves in; `TypedText` owns that animation and the
  // sr-only copy that keeps the full title visible to crawlers and assistive
  // tech while the animated span is still filling in.
  // With no title set, the hero names the host's company rather than a fixed one.
  const heroTitle = settings?.hero_title || companyName;
  const heroSubtitle =
    settings?.hero_subtitle || t("landingPage.yourEverydayDestinationForShopping");

  return (
    <section
      id="home"
      className="relative flex min-h-[90svh] items-center justify-center overflow-hidden border-b border-[#191919] md:min-h-dvh"
    >
      <div className="absolute inset-0 z-0">
        <picture>
          {settings?.hero_mobile?.storage_path ? (
            <source media="(max-width: 767px)" srcSet={settings.hero_mobile.storage_path} />
          ) : null}
          <img
            src={settings?.hero_desktop?.storage_path || "/landing/hero.png"}
            alt=""
            aria-hidden="true"
            loading="eager"
            fetchPriority="high"
            decoding="async"
            className="absolute inset-0 h-full w-full animate-hero-zoom object-cover object-center motion-reduce:animate-none"
          />
        </picture>
        {/* Dark readabilty overlays */}
        <div className="absolute inset-0 bg-gradient-to-b from-[#050505]/40 via-[#050505]/80 to-[#050505]" />
        <div className="absolute inset-0 bg-gradient-to-r from-[#050505]/90 via-[#050505]/30 to-[#050505]/90" />
      </div>

      <div className="relative z-10 mx-auto max-w-5xl px-4 text-center mt-12 md:mt-0">
        <span className="mb-6 inline-flex items-center gap-1.5 rounded-md border border-[#d4af37]/30 bg-[#191919]/85 px-4 py-1.5 text-xs font-semibold tracking-[0.12em] text-[#f2cd60] backdrop-blur">
          <Sparkles className="h-3.5 w-3.5" />
          {t("landingPage.danatFutureDanatFutureReal")}
        </span>

        <HeroTitle title={heroTitle} />

        <p className="mx-auto min-h-[3em] max-w-2xl text-base sm:text-lg md:text-xl text-[#D6D0C5] leading-relaxed mb-10 font-medium">
          <TypedText text={heroSubtitle} speedMs={22} startDelayMs={1500} />
        </p>

        <div className="flex flex-col sm:flex-row justify-center items-center gap-4">
          {isSectionEnabled("shop_explorer") ? (
            <Button
              asChild
              size="lg"
              className="w-full bg-[#d4af37] px-8 py-6 text-sm font-bold text-[#171204] shadow-[var(--shadow-raised)] sm:w-auto sm:text-base"
            >
              <a href="#shops">
                {settings?.hero_primary_cta_label || t("landing.hero.cta.shops")}
                <ArrowRight className="h-4 w-4 ms-2 inline rtl:rotate-180" />
              </a>
            </Button>
          ) : null}
          {isSectionEnabled("location") ? (
            <Button
              asChild
              size="lg"
              variant="outline"
              className="w-full border-[#d4af37]/55 bg-[#0e0d0b]/35 px-8 py-6 text-sm font-bold text-[#f2cd60] hover:border-[#d4af37] hover:bg-[#d4af37]/10 sm:w-auto sm:text-base"
            >
              <a href="#location">
                <MapPin className="h-4 w-4 me-2 inline" />
                {settings?.hero_secondary_cta_label || t("landing.hero.cta.directions")}
              </a>
            </Button>
          ) : null}
        </div>
      </div>

      <div className="absolute bottom-8 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-2 text-xs text-[#d6d0c5]/70">
        <span>{t("landing.hero.scroll")}</span>
        <ArrowRight className="size-4 rotate-90" aria-hidden="true" />
      </div>
    </section>
  );
}
