import { useEffect, useRef, useState } from "react";
import { Car, Clock, MapPin, Phone, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { type LandingContact, PAGE_SHELL } from "./landingLayout";

interface LocationSectionProps {
  contact: LandingContact;
}

/**
 * قسم الموقع والاتجاهات مع خريطة تُحمَّل عند ظهورها فقط.
 *
 * The embed is deferred until the section scrolls into view; the observer and
 * its flag live with the map that uses them.
 */
export function LocationSection({ contact }: LocationSectionProps) {
  const { t } = useI18n();
  const {
    companyAddress,
    companyMapUrl,
    companyMapsEmbed,
    companyMapsHref,
    companyPhoneHref,
    companyDisplayName,
  } = contact;
  const [mapInView, setMapInView] = useState(false);
  const mapRef = useRef<HTMLDivElement>(null);

  // Intersection observer for lazy map loading
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setMapInView(true);
          observer.disconnect();
        }
      },
      { threshold: 0.1 },
    );
    if (mapRef.current) observer.observe(mapRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <section id="location" ref={mapRef} className={`py-24 ${PAGE_SHELL} scroll-mt-20`}>
      <div className="grid gap-12 lg:grid-cols-2 items-center">
        <div className="space-y-6">
          <span className="flex items-center gap-2 text-xs font-semibold tracking-[0.14em] text-gold-deep">
            <Sparkles className="size-3.5" />
            {t("landingPage.visitDanatAlJahra")}
          </span>
          <h2 className="text-3xl sm:text-4xl font-extrabold text-foreground leading-tight">
            {t("landing.location.title")}
          </h2>
          <div className="w-12 h-1 bg-gradient-to-r from-accent/80 to-accent" />

          <div className="space-y-6 pt-4">
            <div className="flex gap-4">
              <div className="grid h-10 w-10 place-items-center rounded bg-card border border-border text-accent shrink-0">
                <MapPin className="h-5 w-5" />
              </div>
              <div>
                <h4 className="font-bold text-foreground text-sm">
                  {t("landing.location.address")}
                </h4>
                <p className="text-sm text-muted-foreground mt-1 whitespace-pre-line">
                  {companyAddress || t("landing.info.location")}
                </p>
              </div>
            </div>

            <div className="flex gap-4">
              <div className="grid h-10 w-10 place-items-center rounded bg-card border border-border text-accent shrink-0">
                <Clock className="h-5 w-5" />
              </div>
              <div>
                <h4 className="font-bold text-foreground text-sm">{t("landing.location.hours")}</h4>
                <p className="text-sm text-muted-foreground mt-1">
                  {t("landingPage.daily0800Am11")}
                </p>
              </div>
            </div>

            <div className="flex gap-4">
              <div className="grid h-10 w-10 place-items-center rounded bg-card border border-border text-accent shrink-0">
                <Car className="h-5 w-5" />
              </div>
              <div>
                <h4 className="font-bold text-foreground text-sm">
                  {t("landing.location.parking")}
                </h4>
                <p className="text-sm text-muted-foreground mt-1">
                  {t("landingPage.freeAmpleUndergroundSurfaceParking")}
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-4 pt-6">
            {companyMapsHref ? (
              <Button asChild size="lg" className="bg-[#d4af37] px-8 font-bold text-[#171204]">
                <a href={companyMapsHref} target="_blank" rel="noopener noreferrer">
                  <MapPin className="h-4 w-4 ml-2 mr-2 inline" />
                  {t("landing.location.googleMaps")}
                </a>
              </Button>
            ) : null}
            {companyPhoneHref ? (
              <Button
                asChild
                size="lg"
                variant="outline"
                className="rounded-full border-border bg-card text-foreground hover:bg-muted font-bold px-8"
              >
                <a href={companyPhoneHref}>
                  <Phone className="h-4 w-4 ml-2 mr-2 inline" />
                  {t("landing.location.call")}
                </a>
              </Button>
            ) : null}
          </div>
        </div>

        {/* Embedded Lazy Loaded map */}
        <div className="aspect-[4/3] rounded-2xl overflow-hidden border border-border bg-card relative shadow-2xl">
          {mapInView && companyMapsEmbed ? (
            <iframe
              title={`${companyDisplayName} map`}
              src={companyMapsEmbed}
              className="h-full w-full border-0 grayscale dark:filter dark:invert dark:brightness-90 dark:contrast-125"
              allowFullScreen
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
            />
          ) : (
            <div className="h-full w-full flex items-center justify-center px-6 text-center text-xs text-muted-foreground/60 font-bold">
              {companyMapUrl
                ? t("landingPage.mapIsLoading")
                : t("landingPage.locationDetailsWillBeAvailable")}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
