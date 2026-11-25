import { useOptionalI18n } from "@/i18n/provider";
import { formatIsoDateForDisplay, type DateTextDir } from "@/lib/dateDisplay";

/** Read-only date text using app LTR/RTL display rules. */
export function FormattedDate({
  value,
  empty = "—",
  textDir,
  className,
}: {
  value: string | null | undefined;
  empty?: string;
  textDir?: DateTextDir;
  className?: string;
}) {
  const i18n = useOptionalI18n();
  const dir: DateTextDir = textDir ?? i18n?.dir ?? "ltr";
  const text = formatIsoDateForDisplay(value, dir);
  return (
    <span className={className} dir="ltr">
      {text || empty}
    </span>
  );
}
