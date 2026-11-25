import { Building2, MapPin, MessageCircle } from "lucide-react";

import { useI18n } from "@/i18n/provider";
import type { LandingContact } from "./landingLayout";

interface QuickActionsProps {
  contact: LandingContact;
  isSectionEnabled: (key: string) => boolean;
}

/**
 * أزرار الإجراءات السريعة العائمة: المتاجر والاتجاهات وواتساب.
 */
export function QuickActions({ contact, isSectionEnabled }: QuickActionsProps) {
  const { t } = useI18n();
  const { companyMapsHref, companyWhatsappHref } = contact;

  return (
    <div
      className="fixed inset-x-3 z-40 grid grid-flow-col auto-cols-fr gap-2 rounded-2xl border border-[#d4af37]/25 bg-[#0e0d0b]/95 p-2 shadow-[var(--shadow-raised)] backdrop-blur md:inset-x-auto md:end-8 md:flex md:flex-col md:rounded-full md:p-1.5"
      style={{ bottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
    >
      {isSectionEnabled("shop_explorer") ? (
        <a
          href="#shops"
          aria-label={t("landingPage.shopDirectory")}
          className="flex min-h-12 items-center justify-center gap-2 rounded-xl px-3 text-xs font-semibold text-[#f2cd60] transition-colors hover:bg-[#d4af37]/12 md:size-12 md:rounded-full md:p-0"
        >
          <Building2 className="size-5" />
          <span className="md:sr-only">{t("landingPage.shops")}</span>
        </a>
      ) : null}
      {companyMapsHref ? (
        <a
          href={companyMapsHref}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t("landingPage.getDirections")}
          className="flex min-h-12 items-center justify-center gap-2 rounded-xl px-3 text-xs font-semibold text-[#f2cd60] transition-colors hover:bg-[#d4af37]/12 md:size-12 md:rounded-full md:p-0"
        >
          <MapPin className="size-5" />
          <span className="md:sr-only">{t("landingPage.directions")}</span>
        </a>
      ) : null}
      {companyWhatsappHref ? (
        <a
          href={companyWhatsappHref}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t("landingPage.whatsappSupport")}
          className="flex min-h-12 items-center justify-center gap-2 rounded-xl px-3 text-xs font-semibold text-[#f2cd60] transition-colors hover:bg-[#d4af37]/12 md:size-12 md:rounded-full md:p-0"
        >
          <MessageCircle className="size-5" />
          <span className="md:sr-only">{t("landingPage.contact")}</span>
        </a>
      ) : null}
    </div>
  );
}
