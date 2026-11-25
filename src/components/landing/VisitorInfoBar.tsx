import { Building2, Car, Clock, MapPin } from "lucide-react";

import { useI18n } from "@/i18n/provider";
import { PAGE_SHELL } from "./landingLayout";

/**
 * شريط معلومات الزائر السريعة: المتاجر والمواقف والساعات والموقع.
 */
export function VisitorInfoBar() {
  const { t } = useI18n();

  return (
    <section className="bg-card border-y border-border py-8">
      <div className={PAGE_SHELL}>
        <div className="flex flex-nowrap md:flex-wrap items-center justify-between gap-8 overflow-x-auto scrollbar-none pb-4 md:pb-0">
          <div className="flex items-center gap-4 shrink-0">
            <div className="grid h-12 w-12 place-items-center rounded-full bg-muted text-accent border border-accent/20">
              <Building2 className="h-6 w-6" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t("landing.info.stores")}</p>
              <p className="text-lg font-bold text-foreground">{t("landingPage.50Stores")}</p>
            </div>
          </div>
          <div className="h-8 w-px bg-border hidden md:block" />
          <div className="flex items-center gap-4 shrink-0">
            <div className="grid h-12 w-12 place-items-center rounded-full bg-muted text-accent border border-accent/20">
              <Car className="h-6 w-6" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t("landing.info.parking")}</p>
              <p className="text-lg font-bold text-foreground">{t("landingPage.500Spots")}</p>
            </div>
          </div>
          <div className="h-8 w-px bg-border hidden md:block" />
          <div className="flex items-center gap-4 shrink-0">
            <div className="grid h-12 w-12 place-items-center rounded-full bg-muted text-accent border border-accent/20">
              <Clock className="h-6 w-6" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t("landing.info.hours")}</p>
              <p className="text-lg font-bold text-foreground" dir="ltr">
                {t("landingPage.0800Am1130")}
              </p>
            </div>
          </div>
          <div className="h-8 w-px bg-border hidden md:block" />
          <div className="flex items-center gap-4 shrink-0">
            <div className="grid h-12 w-12 place-items-center rounded-full bg-muted text-accent border border-accent/20">
              <MapPin className="h-6 w-6" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">{t("landing.info.location")}</p>
              <p className="text-lg font-bold text-foreground">{t("landingPage.block2Jahra")}</p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
