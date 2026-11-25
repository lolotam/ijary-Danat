import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { LtrText } from "@/components/ui/ltr-text";
import { useI18n } from "@/i18n/provider";
import type { DiscountableInvoice } from "@/hooks/useConcessionInvoices";
import { formatKwd } from "@/lib/money";

export interface ExtraChargeWaiverDialogProps {
  /** الفواتير التي سُدّد إيجارها بالكامل ولا تزال تحمل مصروفات دورية. */
  candidates: DiscountableInvoice[];
  open: boolean;
  pending: boolean;
  onConfirm: (waiveInvoiceIds: string[]) => void;
  onCancel: () => void;
}

/**
 * يسأل المسؤول: هل تُسقَط المصروفات الدورية عن الأشهر المخصومة بالكامل؟
 *
 * Only reached when a discount covers a month's rent entirely and a service
 * charge is still standing — the situation where the operator has made the
 * month free "by any means" and the bill would otherwise still show a number.
 *
 * A checkbox per month rather than one yes/no for the batch. The same fixed
 * discount can cover one month's rent completely and only part of the next, and
 * the months can carry different charges; answering once for all of them is how
 * a charge gets forgiven on a month nobody meant to forgive it on. Defaulting
 * every box to unticked keeps "do nothing" the outcome of dismissing the
 * dialog, so a waiver is always something the operator actively chose.
 */
export function ExtraChargeWaiverDialog({
  candidates,
  open,
  pending,
  onConfirm,
  onCancel,
}: ExtraChargeWaiverDialogProps) {
  const { t, locale } = useI18n();
  const [waived, setWaived] = useState<string[]>([]);

  // Cleared on the open transition, so a previous concession's answer is never
  // carried into the next one. Deliberately NOT keyed on `candidates`: the
  // parent passes a fresh array on every render while this is closed, and an
  // effect that reset state on each of those would only avoid looping by virtue
  // of the `open` guard inside it.
  useEffect(() => {
    if (open) setWaived([]);
  }, [open]);

  const allSelected = candidates.length > 0 && waived.length === candidates.length;

  function toggle(invoiceId: string, checked: boolean) {
    setWaived((current) =>
      checked ? [...current, invoiceId] : current.filter((id) => id !== invoiceId),
    );
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("concessions.waiverTitle")}</DialogTitle>
          <DialogDescription>{t("concessions.waiverDescription")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <label className="flex cursor-pointer items-center gap-3 rounded-md border p-2 text-sm">
            <Checkbox
              checked={allSelected}
              onCheckedChange={(checked) =>
                setWaived(checked === true ? candidates.map((invoice) => invoice.id) : [])
              }
            />
            <span className="font-medium">{t("concessions.waiverSelectAll")}</span>
          </label>

          <div className="max-h-64 space-y-1 overflow-y-auto">
            {candidates.map((invoice) => (
              <label
                key={invoice.id}
                className="flex cursor-pointer items-center gap-3 rounded-md border p-2 text-sm hover:bg-muted/50"
              >
                <Checkbox
                  checked={waived.includes(invoice.id)}
                  onCheckedChange={(checked) => toggle(invoice.id, checked === true)}
                />
                <span className="flex-1">
                  <LtrText>{invoice.code}</LtrText>{" "}
                  <span className="text-muted-foreground">
                    {String(invoice.period_month).padStart(2, "0")}/{invoice.period_year}
                  </span>
                </span>
                <LtrText className="text-muted-foreground">
                  {formatKwd(invoice.extraCharges, locale)}
                </LtrText>
              </label>
            ))}
          </div>

          <Label className="text-xs font-normal text-muted-foreground">
            {t("concessions.waiverHint")}
          </Label>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button type="button" disabled={pending} onClick={() => onConfirm(waived)}>
            {waived.length === 0
              ? t("concessions.waiverKeepAll")
              : t("concessions.waiverConfirm").replace("{count}", String(waived.length))}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
