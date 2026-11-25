import { Sparkles } from "lucide-react";

import { useI18n } from "@/i18n/provider";

/**
 * شريط الإعلانات الموسمية أعلى صفحة الهبوط.
 */
export function AnnouncementStrip() {
  const { t } = useI18n();

  return (
    <div className="relative z-50 bg-ink px-4 pb-2 pt-[calc(0.5rem+env(safe-area-inset-top))] text-center text-xs font-semibold tracking-wide text-ink-foreground">
      <span className="flex items-center justify-center gap-2">
        <Sparkles className="h-3 w-3 text-[#d4af37]" />
        {t("landingPage.seasonalEventsAndNewOpenings")}
      </span>
    </div>
  );
}
