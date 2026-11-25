import { Building, CreditCard, Info, Mail } from "lucide-react";

import { useI18n } from "@/i18n/provider";
import { PAGE_SHELL } from "./landingLayout";

/**
 * قسم الغرض من التطبيق وإفصاح تكامل Google OAuth.
 *
 * Always rendered — it has no section toggle — because Google's OAuth review
 * requires the application's purpose to be visible on the home page.
 */
export function PurposeSection() {
  const { t } = useI18n();

  return (
    <section id="purpose" className="bg-card/40 border-y border-border/80 py-20">
      <div className={PAGE_SHELL}>
        <div className="max-w-4xl mx-auto text-center space-y-4 mb-12">
          <span className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-gold-deep/30 bg-gold-deep/10 text-gold-deep text-xs font-semibold">
            <Info className="size-4 text-gold-deep" />
            {t("landing.purpose.badge")}
          </span>
          <h2 className="text-3xl sm:text-4xl font-extrabold text-foreground tracking-tight">
            {t("landing.purpose.title")}
          </h2>
          <p className="text-muted-foreground text-base leading-relaxed max-w-2xl mx-auto font-medium">
            {t("landing.purpose.sub")}
          </p>
        </div>

        <div className="grid gap-6 md:grid-cols-3 max-w-5xl mx-auto">
          <div className="rounded-2xl border border-border bg-card p-6 shadow-lg space-y-3 transition-colors hover:border-gold-deep/40">
            <div className="grid size-12 place-items-center rounded-xl bg-gold-deep/10 text-gold-deep border border-gold-deep/20">
              <Building className="size-6" />
            </div>
            <h3 className="text-lg font-bold text-foreground">
              {t("landing.purpose.card1.title")}
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t("landing.purpose.card1.body")}
            </p>
          </div>

          <div className="rounded-2xl border border-gold-deep/40 bg-card p-6 shadow-xl space-y-3 relative overflow-hidden">
            <div className="absolute top-0 end-0 px-3 py-1 bg-gold-deep/20 text-gold-deep text-[10px] font-bold uppercase tracking-wider rounded-bl-lg">
              OAuth Integration
            </div>
            <div className="grid size-12 place-items-center rounded-xl bg-gold-deep/10 text-gold-deep border border-gold-deep/20">
              <Mail className="size-6" />
            </div>
            <h3 className="text-lg font-bold text-foreground">
              {t("landing.purpose.card2.title")}
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t("landing.purpose.card2.body")}
            </p>
          </div>

          <div className="rounded-2xl border border-border bg-card p-6 shadow-lg space-y-3 transition-colors hover:border-gold-deep/40">
            <div className="grid size-12 place-items-center rounded-xl bg-gold-deep/10 text-gold-deep border border-gold-deep/20">
              <CreditCard className="size-6" />
            </div>
            <h3 className="text-lg font-bold text-foreground">
              {t("landing.purpose.card3.title")}
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t("landing.purpose.card3.body")}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
