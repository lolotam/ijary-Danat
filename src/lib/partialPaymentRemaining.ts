import type { InvoiceState } from "@/integrations/supabase/database.types";

export type PartialPaymentEditInvoice = {
  balance: number;
  code: string;
  id: string;
  period_month: number;
  period_year: number;
  state: InvoiceState;
};

export type PartialPaymentEditContext = {
  credited_amount: number;
  invoice: PartialPaymentEditInvoice | null;
  settled: boolean;
};

/**
 * الرصيد الذي يجوز إدخاله في حوار التعديل لهذه الفاتورة المختارة.
 *
 * The invoice still stores `paid` including this row's own allocation, so the
 * cap on the *current* invoice is `balance + credited_amount`. Any other
 * invoice's cap is its plain remaining balance. Returns null when the dialog
 * has no context yet, so a missing fetch cannot cap at zero.
 */
export function remainingForEdit(
  context: PartialPaymentEditContext | null | undefined,
  selectedInvoiceId: string | null | undefined,
  settleableInvoices: ReadonlyArray<{ id: string; balance: number }>,
): number | null {
  if (!context || !selectedInvoiceId) return null;
  if (context.invoice && selectedInvoiceId === context.invoice.id) {
    return context.invoice.balance + context.credited_amount;
  }
  const other = settleableInvoices.find((invoice) => invoice.id === selectedInvoiceId);
  return other?.balance ?? null;
}
