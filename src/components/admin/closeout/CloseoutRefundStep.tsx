import type { UseFormReturn } from "react-hook-form";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LtrText } from "@/components/ui/ltr-text";
import { useI18n } from "@/i18n/provider";
import type { CloseoutInput } from "@/lib/closeoutSchemas";
import { formatKwd } from "@/lib/money";
import { num, type PreviewResult } from "@/components/admin/closeout/closeoutShared";

/**
 * الخطوة 5: مبلغ الاسترداد، مقترحاً من المعاينة وقابلاً للتخفيض فقط.
 *
 * The input binds a string and mirrors a parsed number into the form, so a
 * half-typed amount never becomes client-side money maths.
 */
export function CloseoutRefundStep({
  preview,
  refundAmountStr,
  setRefundAmountStr,
  form,
}: {
  preview: PreviewResult | null;
  refundAmountStr: string;
  setRefundAmountStr: (value: string) => void;
  form: UseFormReturn<CloseoutInput>;
}) {
  const { t, locale } = useI18n();
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">{t("closeout.step.5")}</h2>
      <p className="text-sm text-muted-foreground">{t("closeout.refundHelp")}</p>
      {preview ? (
        <p className="text-sm">
          {t("closeout.suggestedRefund")}:{" "}
          <LtrText className="font-medium">{formatKwd(num(preview.refund_total), locale)}</LtrText>
        </p>
      ) : null}
      <div className="max-w-xs space-y-2">
        <Label htmlFor="refund-amount">{t("closeout.refundAmount")}</Label>
        <Input
          id="refund-amount"
          type="text"
          inputMode="decimal"
          dir="ltr"
          value={refundAmountStr}
          onChange={(event) => {
            setRefundAmountStr(event.target.value);
            const parsed = Number(event.target.value.replace(/,/g, ""));
            form.setValue(
              "refundAmount",
              event.target.value.trim() === "" ? null : Number.isFinite(parsed) ? parsed : null,
              { shouldDirty: true },
            );
          }}
        />
        <p className="text-xs text-muted-foreground">{t("closeout.refundDownOnly")}</p>
      </div>
    </div>
  );
}
