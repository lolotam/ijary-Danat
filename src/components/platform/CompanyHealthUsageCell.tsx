import { useI18n } from "@/i18n/provider";

/** حدّ التنبيه: 80% من السقف، مطابق لـ `NOTICE_RATIO` في `UsageCard.tsx`. */
const USAGE_WARNING_RATIO = 0.8;

/**
 * يقرّر ما إذا بلغ الاستهلاك 80% أو أكثر من الحد الأقصى المحدّد.
 */
function isUsageNearLimit(used: number, max: number | null): boolean {
  return max !== null && used >= max * USAGE_WARNING_RATIO;
}

/** خصائص خلية عرض الاستهلاك مقابل السقف. */
export interface CompanyHealthUsageCellProps {
  used: number;
  max: number | null;
  formatValue?: (value: number) => string;
}

/**
 * يعرض الاستهلاك بصيغة `used / max` (أو "غير محدود" عند غياب السقف)
 * مع تمييز بصري عند بلوغ 80% فأكثر من الحد الأقصى.
 */
export function CompanyHealthUsageCell({
  used,
  max,
  formatValue = (value) => String(value),
}: CompanyHealthUsageCellProps) {
  const { t } = useI18n();
  const nearLimit = isUsageNearLimit(used, max);

  return (
    <span
      dir="ltr"
      data-near-limit={nearLimit ? "true" : undefined}
      className={
        nearLimit ? "tabular-nums font-semibold text-warning" : "tabular-nums text-muted-foreground"
      }
    >
      {formatValue(used)} / {max === null ? t("limitsUi.unlimited") : formatValue(max)}
    </span>
  );
}
