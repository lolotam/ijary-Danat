import { useState } from "react";
import { BadgeCheck } from "lucide-react";
import { toast } from "sonner";

import { MarkInvoicePaidDialog } from "@/components/admin/MarkInvoicePaidDialog";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/provider";
import { markInvoicesPaidSequentially, type BulkSettleInvoice } from "@/lib/invoiceBulkSelection";
import { markPaidToastKey } from "@/lib/paymentErrors";

/**
 * شريط تعليم الفواتير المحددة كمدفوعة بسبب واحد يُجمع مرة واحدة.
 *
 * Counts success from the boolean `markOne` returns. The existing single-row
 * callers catch and resolve `false`, so a reject-based loop would report every
 * failure as a success.
 */
export function BulkMarkPaidBar<T extends BulkSettleInvoice>({
  selected,
  markOne,
  clear,
  onFinished,
  disabled,
}: {
  selected: T[];
  markOne: (invoice: T, reason: string) => Promise<boolean>;
  clear: () => void;
  /**
   * يحدّث استعلامات الفواتير مرة واحدة بعد انتهاء الدفعة كلها.
   *
   * Refresh the invoice queries once the whole batch is done.
   *
   * `markOne` used to invalidate after every invoice, which meant settling N
   * invoices refetched the list N times — and since the tenant and contract
   * screens stopped capping that list, each refetch pulls the contract's entire
   * history. On a twenty-year lease the batch spent its time refetching, not
   * settling, and looked hung.
   */
  onFinished: () => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [confirm, setConfirm] = useState(false);
  const [pending, setPending] = useState(false);

  if (selected.length === 0) return null;

  /**
   * يجمع السبب مرة واحدة ثم يعلّم الفواتير بالترتيب الزمني للفترة.
   */
  async function runMarkPaid(reason: string) {
    setPending(true);
    try {
      const { ok, failedCodes, firstError } = await markInvoicesPaidSequentially(
        selected,
        reason,
        markOne,
      );
      setConfirm(false);
      clear();
      onFinished();
      if (failedCodes.length === 0) {
        toast.success(`${t("invoices.paidSynced")} (${ok})`);
        return;
      }
      const listed = t("invoices.markPaidBulkPartialFailure").replace(
        "{codes}",
        failedCodes.join(", "),
      );
      // The codes alone say what failed but never why. `markPaidToastKey`
      // recognises the chronological refusal, which is the one cause an admin
      // can act on — include it whenever it is what happened.
      const causeKey = markPaidToastKey(firstError);
      toast.error(causeKey === "common.error" ? listed : `${listed} — ${t(causeKey)}`);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/40 px-4 py-2 text-sm">
        <span className="font-medium">
          {selected.length} {t("invoices.title")}
        </span>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={clear} disabled={pending}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" disabled={disabled || pending} onClick={() => setConfirm(true)}>
            <BadgeCheck className="me-1 size-4" />
            {t("invoices.markPaidBulk")}
          </Button>
        </div>
      </div>
      <MarkInvoicePaidDialog
        open={confirm}
        invoiceCode={null}
        selectedCount={selected.length}
        pending={pending}
        onOpenChange={(open) => {
          if (!open && !pending) setConfirm(false);
        }}
        onConfirm={(reason) => {
          void runMarkPaid(reason);
        }}
      />
    </>
  );
}
