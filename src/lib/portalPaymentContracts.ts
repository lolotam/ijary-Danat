import type { PortalPayment } from "@/hooks/usePortalData";
import { roundToFils } from "@/lib/fils";

/**
 * يُرشِّح المدفوعات حسب العقد المختار.
 *
 * `payments` carries no contract_id — a payment reaches a contract only through
 * its allocated invoices, and the portal lets one payment settle invoices from
 * two contracts at once. So a spanning payment appears under BOTH contracts:
 * hiding it from one would hide money the tenant actually paid on it.
 *
 * A payment that resolves to NO contract is kept in every view rather than
 * dropped. The old comment here said such a payment "shows only in the all
 * view", but there is no all view: `resolvePortalContractId` falls back to the
 * first contract, so `contractId` is null only for a tenant who has none. That
 * made this branch a disappearance, not a scoping rule.
 *
 * Two things land in it, and both are money the tenant must be able to see:
 * a payment sitting unapplied, and — since migration 214 — one partly applied
 * to a hidden lease with a remainder left over, whose allocated invoice tenant
 * RLS will not resolve. A payment applied *entirely* to a hidden lease never
 * reaches here; `portal_hidden_payment_ids` removes it upstream.
 */
export function filterPaymentsByContract(
  payments: PortalPayment[],
  contractId: string | null,
): PortalPayment[] {
  if (!contractId) return payments;
  return payments.filter(
    (payment) => payment.contractIds.length === 0 || payment.contractIds.includes(contractId),
  );
}

/**
 * يُرجع حصة العقد المختار من الدفعة، أو الدفعة كاملة عند اختيار "كل العقود".
 *
 * A payment that settled invoices from two contracts is listed under both. If
 * each listing reported the whole `payment.amount`, any sum the tenant takes of
 * a contract-scoped view — on screen or in the CSV — would count that money
 * twice; and listing every period under each would credit one contract with the
 * other's months. `byContract` carries the allocated slice, so a scoped view
 * reports what the payment actually put against that contract.
 *
 * Receipts deliberately do NOT use this: a receipt documents the transaction
 * that was made, not one contract's share of it.
 */
export function paymentSliceForContract(
  payment: PortalPayment,
  contractId: string | null,
): { amount: number; periods: PortalPayment["periods"] } {
  const slice = contractId ? payment.byContract[contractId] : null;
  if (slice) return slice;
  // A payment that resolves to no visible contract reports ONLY what is left
  // unapplied. Reporting `payment.amount` would put the hidden lease's share
  // back on screen under a contract it was never paid against, and count it
  // again in any total the tenant takes. A genuinely unallocated payment has
  // `allocatedAmount` 0, so this is its full amount, as before.
  if (!payment.contractIds.length) {
    // `?? 0` is the deploy window, not defensiveness for its own sake: a
    // TanStack Query entry filled by the previous bundle has no
    // `allocatedAmount`, and `amount - undefined` is NaN on screen. Treating a
    // missing value as "nothing allocated" shows the full payment, which is
    // what that bundle showed a moment earlier.
    return {
      amount: roundToFils(payment.amount - (payment.allocatedAmount ?? 0)),
      periods: [],
    };
  }
  return { amount: payment.amount, periods: payment.periods };
}
