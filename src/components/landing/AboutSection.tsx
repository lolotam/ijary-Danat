import { ArrowRight, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useHostBrandName } from "@/hooks/useHostBrandName";
import type { LandingPageSettingsWithMedia } from "@/hooks/useLandingSettings";
import { useI18n } from "@/i18n/provider";
import { PAGE_SHELL } from "./landingLayout";

interface AboutSectionProps {
  settings: LandingPageSettingsWithMedia | null | undefined;
  isSectionEnabled: (key: string) => boolean;
}

/**
 * قسم «عن المجمع»: الصورتان والنص وزر دليل المتاجر.
 */
export function AboutSection({ settings, isSectionEnabled }: AboutSectionProps) {
  const { t, dir } = useI18n();
  const companyName = useHostBrandName();

  return (
    <section id="about" className={`py-24 ${PAGE_SHELL}`}>
      <div className="grid items-center gap-12 lg:grid-cols-2">
        {/* Visual layout stacking */}
        <div className={`relative ${dir === "rtl" ? "lg:order-2" : "lg:order-1"}`}>
          <div className="aspect-[4/5] overflow-hidden rounded-2xl border border-border shadow-2xl relative">
            <img
              src={settings?.about_primary?.storage_path || "/landing/feature.png"}
              alt={companyName}
              className="h-full w-full object-cover transition-transform duration-1000 hover:scale-105 motion-reduce:transition-none motion-reduce:hover:scale-100"
              loading="lazy"
              decoding="async"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-transparent" />
          </div>
          <div className="absolute -bottom-6 -end-6 md:-bottom-8 md:-end-8 w-2/3 aspect-video rounded-xl overflow-hidden border border-[#C98A24]/40 shadow-2xl hidden sm:block">
            <img
              src={settings?.about_secondary?.storage_path || "/landing/hero.png"}
              alt={companyName}
              className="h-full w-full object-cover"
              loading="lazy"
              decoding="async"
            />
          </div>
        </div>

        <div className={`space-y-6 max-w-xl ${dir === "rtl" ? "lg:order-1" : "lg:order-2"}`}>
          <span className="flex items-center gap-2 text-xs font-semibold tracking-[0.14em] text-gold-deep">
            <Sparkles className="size-3.5" />
            {t("landingPage.architecturalLandmark")}
          </span>
          <h2 className="text-3xl sm:text-4xl font-extrabold text-foreground leading-tight">
            {settings?.about_title || t("landingPage.aboutDanatAlJahra")}
          </h2>
          <div className="h-1 w-12 rounded-full bg-gold-deep" />
          <p className="text-muted-foreground text-base leading-relaxed whitespace-pre-line font-medium">
            {settings?.about_body || t("landingPage.danatAlJahraBringsSelected")}
          </p>
          {isSectionEnabled("shop_explorer") ? (
            <Button
              asChild
              size="lg"
              className="border-gold-deep/40 bg-transparent px-8 font-semibold text-gold-deep hover:border-gold-deep hover:bg-gold-deep hover:text-white"
            >
              <a href="#shops">
                {t("landing.about.cta")}
                <ArrowRight className="h-4 w-4 ms-2 inline rtl:rotate-180" />
              </a>
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
