import { useCompany } from "@/hooks/useCompany";
import { useI18n } from "@/i18n/provider";
import { cn } from "@/lib/utils";

/**
 * شريط إعلانات متحرك في ترويسة البوابة، يتحكم به المسؤول من الإعدادات.
 *
 * The text node is duplicated and the track translated by -50%: that is what
 * makes an infinite marquee seamless without JavaScript measuring anything.
 * The duplicate is aria-hidden so assistive tech announces the message once.
 *
 * Direction follows the UI locale — Arabic scrolls right-to-left, English
 * left-to-right — because a marquee running against the reading direction is
 * read as broken rather than as decoration.
 *
 * Root uses min-w-0 flex-1 overflow-hidden so a long line cannot push the
 * sign-out control off a 360px phone; without min-w-0 a flex child refuses to
 * shrink below its content width.
 */
export function AnnouncementBanner() {
  const { data: company, isLoading } = useCompany();
  const { locale, dir } = useI18n();

  if (isLoading || !company?.announcement_enabled) return null;

  const text =
    locale === "ar"
      ? (company.announcement_ar ?? "").trim()
      : (company.announcement_en ?? "").trim();

  if (!text) return null;

  return (
    <div
      role="status"
      className="hidden sm:block min-w-0 flex-1 overflow-hidden rounded-md bg-accent/15 px-2 py-1"
    >
      <div
        className={cn(
          "flex w-max max-w-none gap-12 text-sm font-bold text-accent motion-reduce:w-full motion-reduce:max-w-full motion-reduce:flex-wrap motion-reduce:gap-0 motion-reduce:whitespace-normal motion-reduce:animate-none",
          "whitespace-nowrap hover:[animation-play-state:paused] focus-within:[animation-play-state:paused]",
          dir === "rtl" ? "animate-portal-marquee-rtl" : "animate-portal-marquee-ltr",
        )}
      >
        <span className="motion-reduce:whitespace-normal">{text}</span>
        <span aria-hidden="true" className="motion-reduce:hidden">
          {text}
        </span>
      </div>
    </div>
  );
}
