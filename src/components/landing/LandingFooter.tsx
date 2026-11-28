import { Link } from "@tanstack/react-router";
import { Globe, Instagram, Mail, MapPin, Phone } from "lucide-react";

import { BrandLogo } from "@/components/BrandLogo";
import { useI18n } from "@/i18n/provider";
import type { visibleLandingNavigation } from "@/lib/landingNavigation";
import { type LandingContact, PAGE_SHELL } from "./landingLayout";

interface LandingFooterProps {
  contact: LandingContact;
  navigationItems: ReturnType<typeof visibleLandingNavigation>;
}

/**
 * تذييل الصفحة: التواصل والروابط السريعة والحسابات الاجتماعية.
 */
export function LandingFooter({ contact, navigationItems }: LandingFooterProps) {
  const { t } = useI18n();
  const {
    companyAddress,
    companyDisplayName,
    companyEmail,
    companyFacebook,
    companyInstagram,
    companyPhone,
    companyPhoneHref,
  } = contact;

  return (
    <footer
      id="contact"
      className="scroll-mt-20 border-t border-[#d4af37]/20 bg-ink pb-36 pt-16 text-ink-foreground md:py-16"
    >
      <div className={PAGE_SHELL}>
        <div className="grid gap-12 border-b border-[#d4af37]/20 pb-12 md:grid-cols-12">
          <div className="space-y-4 md:col-span-5">
            <BrandLogo name={companyDisplayName} onDark />
            <p className="max-w-md text-sm font-medium leading-relaxed text-[#d6d0c5]">
              {companyAddress || t("landingPage.aPremiumCommercialHubManaged")}
            </p>
          </div>

          <div className="md:col-span-2">
            <h4 className="mb-4 text-base font-semibold text-white">
              {t("landingPage.quickLinks")}
            </h4>
            <ul className="space-y-2 text-sm font-medium text-[#d6d0c5]">
              {navigationItems.map((item) => (
                <li key={item.href}>
                  <a href={item.href} className="transition-colors hover:text-[#f2cd60]">
                    {t(item.labelKey)}
                  </a>
                </li>
              ))}
              <li>
                <Link to="/privacy" className="transition-colors hover:text-[#f2cd60]">
                  {t("footer.privacy")}
                </Link>
              </li>
              <li>
                <Link to="/terms" className="transition-colors hover:text-[#f2cd60]">
                  {t("footer.terms")}
                </Link>
              </li>
            </ul>
          </div>

          <div className="md:col-span-3">
            <h4 className="mb-4 text-base font-semibold text-white">
              {t("landingPage.leasingContact")}
            </h4>
            <ul className="space-y-3 text-sm font-medium text-[#d6d0c5]">
              {companyPhone ? (
                <li className="flex items-center gap-2">
                  <Phone className="h-4 w-4 text-[#f2cd60]" />
                  {companyPhoneHref ? (
                    <a href={companyPhoneHref} className="hover:text-[#f2cd60]">
                      {companyPhone}
                    </a>
                  ) : (
                    <span>{companyPhone}</span>
                  )}
                </li>
              ) : null}
              {companyEmail ? (
                <li className="flex items-center gap-2">
                  <Mail className="h-4 w-4 text-[#f2cd60]" />
                  <a href={`mailto:${companyEmail}`} className="hover:text-[#f2cd60]">
                    {companyEmail}
                  </a>
                </li>
              ) : null}
              {companyAddress ? (
                <li className="flex items-start gap-2">
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-[#f2cd60]" />
                  <span className="whitespace-pre-line">{companyAddress}</span>
                </li>
              ) : null}
            </ul>
          </div>

          <div className="md:col-span-2">
            <h4 className="mb-4 text-base font-semibold text-white">{t("landingPage.followUs")}</h4>
            <div className="flex gap-4">
              {companyInstagram ? (
                <a
                  href={
                    /^https?:\/\//i.test(companyInstagram)
                      ? companyInstagram
                      : `https://${companyInstagram}`
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Instagram"
                  className="grid size-10 place-items-center rounded-lg border border-[#d4af37]/25 bg-white/5 text-[#d6d0c5] transition-colors hover:border-[#d4af37] hover:text-[#f2cd60]"
                >
                  <Instagram className="h-4 w-4" />
                </a>
              ) : null}
              {companyFacebook ? (
                <a
                  href={
                    /^https?:\/\//i.test(companyFacebook)
                      ? companyFacebook
                      : `https://${companyFacebook}`
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Facebook"
                  className="grid size-10 place-items-center rounded-lg border border-[#d4af37]/25 bg-white/5 text-[#d6d0c5] transition-colors hover:border-[#d4af37] hover:text-[#f2cd60]"
                >
                  <Globe className="h-4 w-4" />
                </a>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex flex-col items-center justify-between gap-4 pt-8 text-sm font-medium text-[#a9a18e] sm:flex-row">
          <p>
            © {new Date().getFullYear()} — {t("footer.rights")} | {companyDisplayName}
          </p>
          <div className="flex items-center gap-4 text-xs">
            <Link to="/privacy" className="transition-colors hover:text-[#f2cd60]">
              {t("footer.privacy")}
            </Link>
            <span>•</span>
            <Link to="/terms" className="transition-colors hover:text-[#f2cd60]">
              {t("footer.terms")}
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
