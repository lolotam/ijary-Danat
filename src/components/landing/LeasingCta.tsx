import { MessageCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { LandingPageSettingsWithMedia } from "@/hooks/useLandingSettings";
import { useI18n } from "@/i18n/provider";
import { PAGE_SHELL } from "./landingLayout";

interface LeasingCtaProps {
  settings: LandingPageSettingsWithMedia | null | undefined;
  companyWhatsappHref: string | null;
  setLeasingDialogOpen: (open: boolean) => void;
}

/**
 * قسم دعوة التأجير التجاري: يفتح نموذج الطلب أو محادثة واتساب.
 */
export function LeasingCta({
  settings,
  companyWhatsappHref,
  setLeasingDialogOpen,
}: LeasingCtaProps) {
  const { t } = useI18n();

  return (
    <section
      id="leasing"
      className="scroll-mt-20 border-y border-[#d4af37]/20 bg-ink py-24 text-ink-foreground"
    >
      <div className={`${PAGE_SHELL} text-center`}>
        <span className="mb-3 block text-xs font-semibold tracking-[0.14em] text-[#f2cd60]">
          {t("landingPage.commercialLeasingOpportunities")}
        </span>
        <h2 className="mb-6 text-3xl font-bold leading-tight tracking-[-0.035em] text-white sm:text-5xl">
          {settings?.leasing_title || t("landing.leasing.title")}
        </h2>
        <p className="mx-auto mb-10 max-w-2xl text-base font-medium leading-relaxed text-[#d6d0c5] sm:text-lg">
          {settings?.leasing_body || t("landing.leasing.subtitle")}
        </p>
        <div className="flex flex-col sm:flex-row justify-center items-center gap-4">
          <Button
            onClick={() => setLeasingDialogOpen(true)}
            size="lg"
            className="w-full bg-[#d4af37] px-8 py-6 font-bold text-[#171204] sm:w-auto"
          >
            {t("landing.leasing.cta")}
          </Button>
          {companyWhatsappHref ? (
            <Button
              asChild
              size="lg"
              variant="outline"
              className="w-full border-[#d4af37]/35 bg-white/5 px-8 py-6 font-semibold text-[#f5efe0] hover:bg-[#d4af37]/10 hover:text-white sm:w-auto"
            >
              <a href={companyWhatsappHref} target="_blank" rel="noopener noreferrer">
                <MessageCircle className="mx-2 inline size-5 text-[#f2cd60]" />
                {t("landing.leasing.whatsapp")}
              </a>
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
