/**
 * Attributing payments to a contract.
 *
 * `payments` carries `tenant_id` and `unit_id` and no `contract_id`. A payment
 * reaches a contract only through `payment_allocations → invoices.contract_id`,
 * and one payment can allocate across invoices belonging to two different
 * contracts. Payments are therefore not partitionable by contract.
 *
 * So a contract tab shows the amount **allocated to that contract**, never the
 * payment total. A 500 KWD payment split 300/200 across two contracts reading
 * 500 under each would have the two tabs claim 1000 KWD was paid.
 *
 * Kept free of Supabase imports so the arithmetic is testable on its own.
 */

interface AllocationRow {
  payment_id: string;
  invoice_id: string;
  amount: number;
}

/**
 * Sums each payment's allocations that landed on `contractInvoiceIds`, keyed by
 * payment id. Allocations against any other contract's invoices are ignored
 * rather than counted, which is the whole point.
 */
export function allocatedAmountByPayment(
  allocations: AllocationRow[],
  contractInvoiceIds: Iterable<string>,
): Map<string, number> {
  const mine = new Set(contractInvoiceIds);
  const byPayment = new Map<string, number>();
  for (const allocation of allocations) {
    if (!mine.has(allocation.invoice_id)) continue;
    byPayment.set(
      allocation.payment_id,
      (byPayment.get(allocation.payment_id) ?? 0) + Number(allocation.amount ?? 0),
    );
  }
  return byPayment;
}

/**
 * Joins payments to their allocated amount for one contract, newest payment
 * first. A payment with nothing allocated to this contract is dropped — it
 * belongs to another contract, or to none yet, and listing it here would
 * attribute money to a lease that never received it.
 */
export function attributePaymentsToContract<
  T extends { id: string; payment_date: string; amount: number },
>(payments: T[], allocatedByPayment: Map<string, number>): Array<T & { allocated: number }> {
  return payments
    .filter((payment) => allocatedByPayment.has(payment.id))
    .map((payment) => ({ ...payment, allocated: allocatedByPayment.get(payment.id) ?? 0 }))
    .sort((left, right) => right.payment_date.localeCompare(left.payment_date));
}
