import type { UseFormReturn } from "react-hook-form";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { FormattedDate } from "@/components/ui/formatted-date";
import { LtrText } from "@/components/ui/ltr-text";
import { useI18n } from "@/i18n/provider";
import type { CloseoutInput } from "@/lib/closeoutSchemas";
import { formatKwd } from "@/lib/money";
import { closeoutOutcomeTone } from "@/lib/statusTone";
import { num, type PreviewResult } from "@/components/admin/closeout/closeoutShared";
import type { Contract } from "@/hooks/useContracts";

/**
 * الخطوة 7: ملخص قبل التنفيذ، وخانة التأكيد التي لا يُرسل الإغلاق بدونها.
 */
export function CloseoutConfirmStep({
  contract,
  form,
  refundAmountStr,
  preview,
  confirmed,
  setConfirmed,
}: {
  contract: Contract;
  form: UseFormReturn<CloseoutInput>;
  refundAmountStr: string;
  preview: PreviewResult | null;
  confirmed: boolean;
  setConfirmed: (value: boolean) => void;
}) {
  const { t, locale } = useI18n();
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">{t("closeout.step.7")}</h2>
      <p className="text-sm text-muted-foreground">{t("closeout.confirmHelp")}</p>
      <dl className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">{t("common.code")}</dt>
          <dd className="font-mono text-sm">
            <LtrText>{contract.code}</LtrText>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t("closeout.moveOutDate")}</dt>
          <dd>
            <FormattedDate value={form.watch("moveOutDate")} />
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t("closeout.outcome")}</dt>
          <dd>
            <Badge variant={closeoutOutcomeTone(form.watch("outcome"))}>
              {t(`closeout.outcome.${form.watch("outcome")}`)}
            </Badge>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t("closeout.finalContractState")}</dt>
          <dd>{t(`contractState.${form.watch("finalContractState")}`)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t("closeout.refundAmount")}</dt>
          <dd>
            <LtrText>
              {formatKwd(
                refundAmountStr.trim() === "" ? 0 : Number(refundAmountStr.replace(/,/g, "")) || 0,
                locale,
              )}
            </LtrText>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t("closeout.deductionsCount")}</dt>
          <dd>
            <LtrText>{String((form.watch("deductions") ?? []).length)}</LtrText>
          </dd>
        </div>
        {preview ? (
          <>
            <div>
              <dt className="text-xs text-muted-foreground">{t("closeout.deductionsTotal")}</dt>
              <dd>
                <LtrText>{formatKwd(num(preview.deductions_total), locale)}</LtrText>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t("closeout.refundTotal")}</dt>
              <dd>
                <LtrText>{formatKwd(num(preview.refund_total), locale)}</LtrText>
              </dd>
            </div>
          </>
        ) : null}
      </dl>
      <p className="text-xs text-muted-foreground">{t("closeout.confirmNoClientMath")}</p>
      <label className="flex items-start gap-3 rounded-lg border p-4">
        <Checkbox
          checked={confirmed}
          onCheckedChange={(checked) => setConfirmed(Boolean(checked))}
        />
        <span className="text-sm">{t("closeout.confirmCheckbox")}</span>
      </label>
    </div>
  );
}
