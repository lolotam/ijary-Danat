import { useI18n } from "@/i18n/provider";
import { formatAmount } from "@/lib/money";

/**
 * يظهر مؤشر الدفع الجزئي بجانب شارة الحالة عندما تكون الفاتورة مستحقة أو متأخرة وفيها تحصيل ناقص.
 *
 * Nightly `evaluate_overdue` ranks overdue above `partially_paid`, so a due or
 * overdue row with money already collected is the only place this text can live.
 */
export function InvoicePartialIndicator({
  state,
  paid,
  total,
}: {
  paid: number;
  state: string;
  total: number;
}) {
  const { t, locale } = useI18n();
  if ((state !== "due" && state !== "overdue") || !(paid > 0 && paid < total)) return null;
  return (
    <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
      {t("invoices.partiallyPaidIndicator")
        .replace("{paid}", formatAmount(paid, locale))
        .replace("{total}", formatAmount(total, locale))}
    </span>
  );
}
