import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useOptionListItemsByCode } from "@/hooks/useOptionLists";
import { useI18n } from "@/i18n/provider";
import { isGatewayMethod } from "@/lib/paymentMethodDisplay";

/**
 * قائمة طرق الدفع نفسها التي يستخدمها نموذج "إضافة دفعة".
 *
 * Was `manual_payment_reasons`, a parallel catalog whose items each mapped to a
 * tender type through `metadata.payment_method`. That indirection is what
 * recorded an audit adjustment as Cash: every reason had to point at some
 * existing method, and there was no method that meant "adjustment". Reading the
 * one catalog makes the two dropdowns identical by construction rather than by
 * anyone remembering to keep them in step.
 */
const MANUAL_PAYMENT_METHODS_LIST = "payment_methods";

/**
 * Asks why an invoice is being settled by hand, before it is.
 *
 * Marking an invoice paid used to be a single icon click. That was fine while
 * the only question was "is it paid", but the reason is what tells a bank
 * transfer apart from a cheque apart from a pure data correction — and
 * migration 108 uses it to decide the method the settling payment is recorded
 * under, which reporting then reads. So the answer has to be collected before
 * the money is written, not inferred afterwards.
 *
 * Un-marking deliberately does NOT open this dialog: there is no reason to give
 * for undoing a mistake, and asking for one would imply the reversal is itself
 * an accounting event.
 *
 * Reasons come from the Settings > Lists catalog, so an admin can add, rename,
 * reorder or disable them without a deploy. Only active items are offered.
 */
export function MarkInvoicePaidDialog({
  invoiceCode,
  onConfirm,
  onOpenChange,
  open,
  pending,
  selectedCount,
}: {
  invoiceCode: string | null;
  onConfirm: (method: string) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  pending: boolean;
  /** When set, the copy names N invoices rather than a single code. */
  selectedCount?: number;
}) {
  const { locale, t } = useI18n();
  const methods = useOptionListItemsByCode(MANUAL_PAYMENT_METHODS_LIST, open);
  const [method, setMethod] = useState("");

  // A method chosen for one invoice must not be pre-selected for the next.
  useEffect(() => {
    if (!open) setMethod("");
  }, [open]);

  // Gateway methods are withheld here, and only here. One means money moved
  // through MyFatoorah and left a transaction behind; nothing did on this path,
  // so offering it would let an admin manufacture a payment that reconciliation
  // can never match. `set_invoice_paid` refuses them too — this keeps the UI
  // from presenting a choice the database will reject.
  const options = (methods.data ?? []).filter((item) => !isGatewayMethod(item.value));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("invoices.markPaid")}</DialogTitle>
          <DialogDescription>
            {selectedCount != null
              ? t("invoices.markPaidBulkDescription").replace("{count}", String(selectedCount))
              : invoiceCode
                ? t("invoices.markPaidDescription").replace("{code}", invoiceCode)
                : t("invoices.markPaidDescription")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <Label required htmlFor="manual-payment-reason">
            {t("invoices.manualPaymentReason")}
          </Label>
          <Select value={method} onValueChange={setMethod}>
            <SelectTrigger id="manual-payment-reason">
              <SelectValue placeholder={t("invoices.manualPaymentReasonPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {options.map((item) => (
                <SelectItem key={item.id} value={item.value}>
                  {(locale === "ar" ? item.label_ar : item.label_en) || item.value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {methods.isSuccess && options.length === 0 && (
            <p className="text-sm text-destructive">{t("invoices.manualPaymentReasonEmpty")}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => onConfirm(method)} disabled={!method || pending}>
            {t("invoices.markPaid")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
