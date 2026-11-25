import { MarkInvoicePaidDialog } from "@/components/admin/MarkInvoicePaidDialog";
import type { InvoicePaidToggle } from "@/components/admin/invoices/useInvoicePaidToggle";

/**
 * نافذة اختيار طريقة الدفع المربوطة بحالة `useInvoicePaidToggle`.
 *
 * Its own file because a module exporting both a hook and a component is not
 * Fast Refresh safe: an edit to either one falls back to a full page reload
 * instead of a hot update that keeps component state.
 */
export function InvoicePaidToggleDialog({ toggle }: { toggle: InvoicePaidToggle }) {
  const { markPaidInvoice, paidPending } = toggle;
  return (
    <MarkInvoicePaidDialog
      open={markPaidInvoice !== null}
      invoiceCode={markPaidInvoice?.code ?? null}
      pending={paidPending === markPaidInvoice?.id}
      onOpenChange={(next) => {
        if (!next) toggle.cancelMarkPaid();
      }}
      onConfirm={toggle.confirmMarkPaid}
    />
  );
}
