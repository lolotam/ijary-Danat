import type { InvoiceState } from "@/integrations/supabase/database.types";
import { compareInvoicePeriod } from "@/lib/invoiceSettlement";

/** One invoice as the deposit form needs to see it. */
export type DepositInvoiceInput = {
  balance: number;
  code: string;
  id: string;
  period_month: number;
  period_year: number;
  state: InvoiceState;
};

/**
 * Why an invoice cannot be settled by a deposit, or null when it can.
 *
 * `terminal` — cancelled or waived. `outOfOrder` — an earlier invoice on the
 * same contract is still outstanding.
 */
export type DepositInvoiceBlock = "terminal" | "outOfOrder" | null;

export type DepositInvoiceOption = DepositInvoiceInput & {
  block: DepositInvoiceBlock;
};

const TERMINAL_STATES: ReadonlySet<InvoiceState> = new Set(["cancelled", "waived"]);
const OUTSTANDING_STATES: ReadonlySet<InvoiceState> = new Set(["due", "overdue", "partially_paid"]);

/**
 * يرتّب فواتير العقد ويحدد أيّها يمكن للإيداع تسويتها.
 *
 * The database refuses two of these outright — `deposit_invoice_terminal_state`
 * and `deposit_invoice_out_of_order` — so this exists to make the refusal
 * visible *before* the accountant saves, not to replace it. The trigger stays
 * the authority; a stale list here can only ever be more permissive than the
 * database, never less.
 *
 * A fully paid invoice is deliberately NOT blocked. The whole reason the form
 * lists paid invoices is that the accountant may have marked one paid before
 * recording the deposit that actually paid it, and they still need to record
 * which invoice the money was for. Linking to it settles nothing (the trigger
 * returns early on a zero balance) but the link is the point.
 */
export function depositInvoiceOptions(invoices: DepositInvoiceInput[]): DepositInvoiceOption[] {
  // The shared comparator, so this list names the same "oldest" invoice as the
  // payments dialog; the old one had no tiebreak within a period (audit H8).
  const ordered = [...invoices].sort(compareInvoicePeriod);

  // The chronological rule blocks an invoice when ANY earlier one is still
  // outstanding, so the earliest outstanding invoice is the cutoff: it may be
  // settled, everything after it may not.
  const cutoff = ordered.findIndex(
    (invoice) => invoice.balance > 0 && OUTSTANDING_STATES.has(invoice.state),
  );

  return ordered.map((invoice, index) => ({
    ...invoice,
    block: TERMINAL_STATES.has(invoice.state)
      ? "terminal"
      : cutoff !== -1 && index > cutoff && invoice.balance > 0
        ? "outOfOrder"
        : null,
  }));
}
