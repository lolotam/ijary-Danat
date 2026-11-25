import { LtrText } from "@/components/ui/ltr-text";
import { useI18n } from "@/i18n/provider";
import { formatKwd } from "@/lib/money";
import { num, type PreviewResult } from "@/components/admin/closeout/closeoutShared";

/**
 * الخطوة 4: معاينة التسوية كما يحسبها الخادم.
 */
export function CloseoutPreviewStep({
  loading,
  error,
  preview,
}: {
  loading: boolean;
  error: unknown;
  preview: PreviewResult | null;
}) {
  const { t, locale } = useI18n();
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">{t("closeout.step.4")}</h2>
      <p className="text-sm text-muted-foreground">{t("closeout.previewHelp")}</p>
      {loading ? (
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      ) : error ? (
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : t("common.error")}
        </p>
      ) : preview ? (
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(
            [
              ["deposit_held", t("closeout.depositHeld")],
              ["deductions_total", t("closeout.deductionsTotal")],
              ["settled_total", t("closeout.settledTotal")],
              ["written_off_total", t("closeout.writtenOffTotal")],
              ["available", t("closeout.available")],
              ["refund_total", t("closeout.refundTotal")],
              ["balance_due_tenant", t("closeout.balanceDue")],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="rounded-lg border p-3">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="mt-1 text-base font-semibold">
                <LtrText>{formatKwd(num(preview[key]), locale)}</LtrText>
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
