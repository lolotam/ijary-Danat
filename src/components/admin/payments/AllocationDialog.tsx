import { useState } from "react";
import { toast } from "sonner";

import { TableState } from "@/components/admin/Phase2Ui";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { Input } from "@/components/ui/input";
import { useInvoices } from "@/hooks/useInvoices";
import { useApplyPaymentAllocation } from "@/hooks/usePaymentAllocations";
import type { PaymentWithTenant } from "@/hooks/usePayments";
import { useI18n } from "@/i18n/provider";
import { formatAmount, formatKwd } from "@/lib/money";

export interface AllocationDialogProps {
  payment: PaymentWithTenant | null;
  onClose: () => void;
}

/**
 * حوار توزيع دفعة قائمة على فواتير المستأجر المفتوحة، مع تأكيد قبل التنفيذ.
 *
 * Extracted from `FullPaymentsPanel` (audit M13, plan row 6.5) together with
 * the amounts it edits and its confirm step. The panel keys it on the payment,
 * so opening it for a payment always starts from empty amounts — the old
 * `setAllocationAmounts({})` beside each "allocate" button. Ordering is not
 * judged here: the `applyAllocation` server fn refuses an out-of-order
 * allocation and its message reaches the toast.
 */
export function AllocationDialog({ payment, onClose }: AllocationDialogProps) {
  const { locale, t } = useI18n();
  const [allocationAmounts, setAllocationAmounts] = useState<Record<string, string>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const applyAllocation = useApplyPaymentAllocation();
  // Every open invoice the tenant holds. Capped at 100 and sorted newest-first,
  // this picker could not reach a long-lease tenant's older invoices at all —
  // the months an allocation is most likely to be settling.
  const eligibleInvoices = useInvoices(
    { fetchAll: true, tenantId: payment?.tenant_id },
    Boolean(payment),
  );
  const selectedAllocations = Object.entries(allocationAmounts)
    .filter(([, amount]) => Number(amount) > 0)
    .map(([invoice_id, amount]) => ({ invoice_id, amount: Number(amount) }));

  /**
   * يطبّق التوزيع المؤكَّد ويغلق الحوار عند النجاح.
   *
   * A refusal — including the server's out-of-order check — reaches the toast
   * as the server's own message, and the dialog stays open so the admin can
   * correct the amounts rather than re-enter them.
   */
  const confirmAllocation = async () => {
    if (!payment || !selectedAllocations.length) return;
    try {
      await applyAllocation.mutateAsync({
        paymentId: payment.id,
        allocations: selectedAllocations,
      });
      toast.success(t("payments.allocated"));
      setConfirmOpen(false);
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("common.error"));
    }
  };

  return (
    <>
      <Dialog open={Boolean(payment)} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("payments.allocate")}</DialogTitle>
            <DialogDescription>
              {payment?.code} — {t("payments.availableAmount")}:{" "}
              {formatKwd(payment?.amount ?? 0, locale)}
            </DialogDescription>
          </DialogHeader>
          <TableState
            loading={eligibleInvoices.isLoading}
            error={eligibleInvoices.isError}
            empty={!eligibleInvoices.data?.items.filter((invoice) => invoice.balance > 0).length}
          >
            <div className="space-y-2">
              {(eligibleInvoices.data?.items ?? [])
                .filter((invoice) => invoice.balance > 0)
                .map((invoice) => (
                  <div
                    key={invoice.id}
                    className="grid grid-cols-[auto_1fr_140px] items-center gap-3 rounded-lg border p-3"
                  >
                    <Checkbox
                      checked={Number(allocationAmounts[invoice.id]) > 0}
                      onCheckedChange={(checked) =>
                        setAllocationAmounts((current) => ({
                          ...current,
                          [invoice.id]: checked ? String(invoice.balance) : "",
                        }))
                      }
                    />
                    <div>
                      <p className="font-medium">{invoice.code}</p>
                      <p className="text-xs text-muted-foreground">
                        {invoice.period_month}/{invoice.period_year} — {t("invoices.balance")}:{" "}
                        {formatAmount(invoice.balance, locale)}
                      </p>
                    </div>
                    <Input
                      type="number"
                      min="0.001"
                      max={invoice.balance}
                      step="0.001"
                      value={allocationAmounts[invoice.id] ?? ""}
                      onChange={(event) =>
                        setAllocationAmounts((current) => ({
                          ...current,
                          [invoice.id]: event.target.value,
                        }))
                      }
                    />
                  </div>
                ))}
            </div>
          </TableState>
          <DialogFooter>
            <Button disabled={!selectedAllocations.length} onClick={() => setConfirmOpen(true)}>
              {t("payments.applyAllocation")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("payments.allocateConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("payments.allocateConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction disabled={applyAllocation.isPending} onClick={confirmAllocation}>
              {t("common.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
