import { Link } from "@tanstack/react-router";
import { Building2, CreditCard, MessageSquare } from "lucide-react";

import { BrandLogo } from "@/components/BrandLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { brandNameFor, brandStyleFor, type PublicBranding } from "@/fns/publicBranding";
import { useI18n } from "@/i18n/provider";

const FEATURES = [
  {
    key: "properties",
    icon: Building2,
    titleKey: "marketing.featurePropertiesTitle",
    bodyKey: "marketing.featurePropertiesBody",
  },
  {
    key: "invoices",
    icon: CreditCard,
    titleKey: "marketing.featureInvoicesTitle",
    bodyKey: "marketing.featureInvoicesBody",
  },
  {
    key: "reminders",
    icon: MessageSquare,
    titleKey: "marketing.featureRemindersTitle",
    bodyKey: "marketing.featureRemindersBody",
  },
] as const;

interface MarketingPageProps {
  branding?: PublicBranding;
}

/**
 * صفحة التسويق الرئيسية لمنصة إيجاري (IJARY) على المضيف الجذري للمنصة.
 *
 * Replaces the temporary platform home page (T196): presents the product
 * value statement, three core capability blocks, and the sign-in entry link
 * without exposing any company's landing content.
 */
export function MarketingPage({ branding }: MarketingPageProps) {
  const { t, dir, toggle, locale } = useI18n();
  const brandName = branding ? brandNameFor(branding, locale) : "IJARY";

  return (
    <div
      dir={dir}
      style={branding ? brandStyleFor(branding) : undefined}
      className="relative min-h-dvh overflow-hidden bg-ink text-white"
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(45,181,167,0.16),transparent_32rem),linear-gradient(110deg,rgba(11,37,35,0.74),rgba(11,37,35,0.96)_68%)]" />

      <header className="relative z-10 mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-6">
        <BrandLogo name={brandName} onDark />
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <button
            type="button"
            onClick={toggle}
            className="min-h-10 rounded-full border border-white/20 px-3 py-1.5 text-xs font-medium text-white/80 transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-highlight"
          >
            {t("nav.language")}
          </button>
          <Link
            to="/auth"
            className="inline-flex min-h-10 items-center rounded-full bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-highlight"
          >
            {t("marketing.signIn")}
          </Link>
        </div>
      </header>

      <main
        id="main-content"
        className="relative z-10 mx-auto flex max-w-6xl flex-col gap-16 px-5 pb-20 pt-12 sm:pt-20"
      >
        <section className="flex max-w-3xl flex-col items-start gap-6 text-start">
          <span className="rounded-full border border-white/15 bg-white/5 px-3.5 py-1 text-xs font-medium text-white/80">
            {t("marketing.eyebrow")}
          </span>
          <h1 className="text-4xl font-bold leading-[1.08] tracking-[-0.03em] sm:text-6xl">
            {t("marketing.heroTitle")}
          </h1>
          <p className="text-lg leading-8 text-white/80 sm:text-xl">{t("marketing.heroTagline")}</p>
          <Link
            to="/auth"
            className="inline-flex min-h-11 items-center rounded-full bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground transition-transform hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-highlight"
          >
            {t("marketing.signIn")}
          </Link>
        </section>

        <section aria-labelledby="marketing-features-heading" className="flex flex-col gap-6">
          <h2
            id="marketing-features-heading"
            className="text-start text-xl font-semibold text-white/90"
          >
            {t("marketing.featuresHeading")}
          </h2>
          <div className="grid gap-5 md:grid-cols-3">
            {FEATURES.map(({ key, icon: Icon, titleKey, bodyKey }) => (
              <article
                key={key}
                className="flex flex-col gap-3 rounded-2xl border border-white/10 bg-white/5 p-6 text-start backdrop-blur-sm"
              >
                <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-primary/20 text-primary">
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </div>
                <h3 className="text-lg font-semibold text-white">{t(titleKey)}</h3>
                <p className="text-sm leading-6 text-white/75">{t(bodyKey)}</p>
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
