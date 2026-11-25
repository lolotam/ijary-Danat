import { ArrowRight, Building, Building2, Car, CreditCard, MapPin, Sparkles } from "lucide-react";

import { useI18n } from "@/i18n/provider";
import { PAGE_SHELL } from "./landingLayout";

/**
 * قسم المرافق والخدمات بشبكة Bento غير المتماثلة.
 */
export function FacilitiesSection() {
  const { t } = useI18n();

  return (
    <section id="facilities" className={`py-24 ${PAGE_SHELL} scroll-mt-20`}>
      <div className="text-center max-w-3xl mx-auto mb-16">
        <span className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-gold-deep/30 bg-gold-deep/10 text-gold-deep text-xs font-semibold">
          <Sparkles className="size-4 text-gold-deep" />
          {t("landing.facilities.title")}
        </span>
        <h2 className="text-3xl sm:text-4xl font-extrabold text-foreground mt-3 mb-4 tracking-tight">
          {t("landing.facilities.subtitle")}
        </h2>
        <p className="text-muted-foreground text-sm sm:text-base max-w-xl mx-auto font-medium">
          {t("landingPage.aComprehensiveRangeOfServices")}
        </p>
        <div className="w-16 h-1 bg-gradient-to-r from-gold-deep/80 via-accent to-gold-deep mx-auto mt-6 rounded-full" />
      </div>

      {/* Asymmetric Bento Grid Layout */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-12 max-w-6xl mx-auto">
        {/* Card 1: Hero Featured Shopping & Services (8 cols) */}
        <div className="lg:col-span-8 rounded-3xl border border-gold-deep/40 bg-gradient-to-br from-card via-card to-gold-deep/5 p-8 shadow-xl relative overflow-hidden flex flex-col justify-between group transition-all duration-300 hover:border-gold-deep hover:shadow-2xl">
          <div className="absolute top-0 end-0 p-8 opacity-10 pointer-events-none group-hover:scale-110 transition-transform duration-500">
            <Building2 className="size-48 text-gold-deep" />
          </div>
          <div className="space-y-4 relative z-10">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-lg bg-gold-deep/15 border border-gold-deep/30 text-gold-deep text-xs font-bold uppercase tracking-wider">
              <Sparkles className="size-3.5" />
              {t("landingPage.featuredDestination")}
            </div>
            <div className="size-14 grid place-items-center rounded-2xl bg-gold-deep/10 border border-gold-deep/20 text-gold-deep shadow-sm">
              <Building2 className="size-7" />
            </div>
            <h3 className="text-2xl sm:text-3xl font-extrabold text-foreground tracking-tight">
              {t("landing.facilities.f1.title")}
            </h3>
            <p className="text-muted-foreground text-base leading-relaxed max-w-xl font-medium">
              {t("landing.facilities.f1.desc")}
            </p>
          </div>
          <div className="pt-6 mt-6 border-t border-border/60 flex items-center gap-2 text-xs font-bold text-gold-deep relative z-10">
            <span>{t("landingPage.exploreShopsServices")}</span>
            <ArrowRight className="size-4 rtl:rotate-180 group-hover:translate-x-1 rtl:group-hover:-translate-x-1 transition-transform" />
          </div>
        </div>

        {/* Card 2: Fine Dining & Cafes (4 cols) */}
        <div className="lg:col-span-4 rounded-3xl border border-border bg-card p-7 shadow-lg relative overflow-hidden flex flex-col justify-between transition-all duration-300 hover:border-gold-deep/50 hover:shadow-xl hover:-translate-y-1">
          <div className="space-y-4">
            <div className="size-12 grid place-items-center rounded-2xl bg-accent/10 border border-accent/20 text-gold-deep shadow-sm">
              <CreditCard className="size-6" />
            </div>
            <h3 className="text-xl font-bold text-foreground">
              {t("landing.facilities.f2.title")}
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed font-medium">
              {t("landing.facilities.f2.desc")}
            </p>
          </div>
          <div className="pt-4 text-xs font-semibold text-muted-foreground flex items-center justify-between">
            <span className="px-2.5 py-1 rounded-full bg-muted text-foreground text-[11px] font-bold">
              {t("landingPage.cafesDining")}
            </span>
          </div>
        </div>

        {/* Card 3: Health & Beauty (6 cols) */}
        <div className="lg:col-span-6 rounded-3xl border border-border bg-card p-7 shadow-lg relative overflow-hidden flex flex-col justify-between transition-all duration-300 hover:border-gold-deep/50 hover:shadow-xl hover:-translate-y-1">
          <div className="space-y-4">
            <div className="size-12 grid place-items-center rounded-2xl bg-accent/10 border border-accent/20 text-gold-deep shadow-sm">
              <Sparkles className="size-6" />
            </div>
            <h3 className="text-xl font-bold text-foreground">
              {t("landing.facilities.f3.title")}
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed font-medium">
              {t("landing.facilities.f3.desc")}
            </p>
          </div>
          <div className="pt-4 text-xs font-semibold text-muted-foreground flex items-center justify-between">
            <span className="px-2.5 py-1 rounded-full bg-muted text-foreground text-[11px] font-bold">
              {t("landingPage.wellnessFitness")}
            </span>
          </div>
        </div>

        {/* Card 4: Prime Vibrant Location (6 cols) */}
        <div className="lg:col-span-6 rounded-3xl border border-border bg-card p-7 shadow-lg relative overflow-hidden flex flex-col justify-between transition-all duration-300 hover:border-gold-deep/50 hover:shadow-xl hover:-translate-y-1">
          <div className="space-y-4">
            <div className="size-12 grid place-items-center rounded-2xl bg-accent/10 border border-accent/20 text-gold-deep shadow-sm">
              <MapPin className="size-6" />
            </div>
            <h3 className="text-xl font-bold text-foreground">
              {t("landing.facilities.f4.title")}
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed font-medium">
              {t("landing.facilities.f4.desc")}
            </p>
          </div>
          <div className="pt-4 text-xs font-semibold text-muted-foreground flex items-center justify-between">
            <span className="px-2.5 py-1 rounded-full bg-muted text-foreground text-[11px] font-bold">
              {t("landingPage.heartOfJahra")}
            </span>
          </div>
        </div>

        {/* Card 5: Ample Parking (6 cols) */}
        <div className="lg:col-span-6 rounded-3xl border border-border bg-card p-7 shadow-lg relative overflow-hidden flex flex-col justify-between transition-all duration-300 hover:border-gold-deep/50 hover:shadow-xl hover:-translate-y-1">
          <div className="space-y-4">
            <div className="size-12 grid place-items-center rounded-2xl bg-accent/10 border border-accent/20 text-gold-deep shadow-sm">
              <Car className="size-6" />
            </div>
            <h3 className="text-xl font-bold text-foreground">
              {t("landing.facilities.f5.title")}
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed font-medium">
              {t("landing.facilities.f5.desc")}
            </p>
          </div>
          <div className="pt-4 text-xs font-semibold text-muted-foreground flex items-center justify-between">
            <span className="px-2.5 py-1 rounded-full bg-muted text-foreground text-[11px] font-bold">
              {t("landingPage.freeAmpleParking")}
            </span>
          </div>
        </div>

        {/* Card 6: Safe Family Environment (6 cols) */}
        <div className="lg:col-span-6 rounded-3xl border border-border bg-card p-7 shadow-lg relative overflow-hidden flex flex-col justify-between transition-all duration-300 hover:border-gold-deep/50 hover:shadow-xl hover:-translate-y-1">
          <div className="space-y-4">
            <div className="size-12 grid place-items-center rounded-2xl bg-accent/10 border border-accent/20 text-gold-deep shadow-sm">
              <Building className="size-6" />
            </div>
            <h3 className="text-xl font-bold text-foreground">
              {t("landing.facilities.f6.title")}
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed font-medium">
              {t("landing.facilities.f6.desc")}
            </p>
          </div>
          <div className="pt-4 text-xs font-semibold text-muted-foreground flex items-center justify-between">
            <span className="px-2.5 py-1 rounded-full bg-muted text-foreground text-[11px] font-bold">
              {t("landingPage.safeFamilyAtmosphere")}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
