/**
 * Deciding whether a blocked gateway settlement may adopt the payments that are
 * blocking it.
 *
 * `set_invoice_paid` (migration 23) is the ONLY writer of the reference
 * `AUTO-INV:<invoice code>`. A cash, cheque or transfer payment recorded by
 * staff goes through `createPayment` with an operator-entered reference and can
 * never carry that prefix. So the prefix means precisely "this row is a
 * placeholder created by the mark-paid checkbox, not evidence that money was
 * received here" — the same invariant that lets the un-mark path safely delete
 * these rows.
 *
 * That makes adoption safe and narrow: relabelling a placeholder to the real
 * gateway method corrects a record that was always a stand-in. Relabelling a
 * genuine second payment would instead hide a double payment, so anything that
 * is not exactly a placeholder for its own invoice is a conflict a human must
 * resolve.
 *
 * Pure by design — no Supabase, no IO — so the rule can be tested directly
 * rather than through the settlement path's mocks.
 */

export type BlockingPayment = {
  /** payments.id */
  id: string;
  /** payments.code, for operator-facing log lines. */
  code: string;
  /** Code of the invoice this payment is allocated to. */
  invoiceCode: string;
  /** payments.method as currently recorded, so the audit row states what was read. */
  method: string;
  /** payments.reference — nullable in the schema. */
  reference: string | null;
};

export type ReconciliationDecision =
  | { kind: "adopt"; payments: BlockingPayment[] }
  | { kind: "conflict"; conflicting: BlockingPayment }
  | { kind: "none" };

/** The reference `set_invoice_paid` stamps on the payment it creates. */
export function manualPlaceholderReference(invoiceCode: string): string {
  return `AUTO-INV:${invoiceCode}`;
}

/**
 * Classify the confirmed payments already allocated to a settlement's invoices.
 *
 * Every payment must be a placeholder *for its own invoice*: a placeholder
 * naming a different invoice is a sign the allocation was hand-edited, which is
 * exactly the situation not to guess about.
 *
 * Note the all-or-nothing rule. A multi-month payment request where one month
 * was placeholder-marked and another was settled by a real earlier gateway
 * payment classifies as `conflict`, so neither is adopted and the placeholder
 * keeps its `cash` label. That is the safe direction to fail — mislabelling one
 * payment is recoverable, silently relabelling a real one is not.
 */
export function classifyBlockingPayments(payments: BlockingPayment[]): ReconciliationDecision {
  if (payments.length === 0) return { kind: "none" };
  const conflicting = payments.find(
    (payment) => payment.reference !== manualPlaceholderReference(payment.invoiceCode),
  );
  if (conflicting) return { kind: "conflict", conflicting };
  return { kind: "adopt", payments };
}
