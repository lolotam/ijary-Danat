import { roundToFils } from "@/lib/fils";

/** فترة فاتورة: الشهر والسنة اللذان غطّتهما الدفعة. */
export interface PortalFoldPeriod {
  month: number;
  year: number;
}

/** حصة عقد واحد من دفعة: المبلغ المخصّص لفواتيره والفترات التي غطّاها. */
export interface PortalFoldSlice {
  amount: number;
  periods: PortalFoldPeriod[];
}

/** ما تحتاجه الطيّ من صف التخصيص. */
export interface PortalFoldAllocation {
  amount: number;
  invoice_id: string;
  payment_id: string;
}

/** الفاتورة كما تُقرأ للطيّ: فترتها والعقد الذي تتبعه. */
export interface PortalFoldInvoice extends PortalFoldPeriod {
  contract_id: string;
}

/** ما يضيفه الطيّ إلى صف الدفعة. */
export interface PortalFoldResult {
  /**
   * مجموع ما خُصّص من الدفعة، سواء أمكن حلّ فاتورته أم لا.
   *
   * Counted from the allocation rows rather than from what resolved, which is
   * the only way to know the unapplied remainder of a payment whose invoices
   * the tenant cannot read. A tenant may read every one of their own
   * `payment_allocations` rows — that policy keys off `payments.tenant_id` —
   * so this is knowable client-side even when the invoices behind them are not.
   */
  allocatedAmount: number;
  byContract: Record<string, PortalFoldSlice>;
  contractIds: string[];
  periods: PortalFoldPeriod[];
}

/** يرتّب الفترات زمنيًا. */
function byPeriod(a: PortalFoldPeriod, b: PortalFoldPeriod): number {
  return a.year - b.year || a.month - b.month;
}

/**
 * يطوي تخصيصات الدفعات إلى فترات وعقود وحصص، ويُسقِط الدفعات المخفية بالكامل.
 *
 * Extracted from `usePortalPayments` so the rule that decides whether a payment
 * disappears is held by tests rather than by reading order.
 *
 * **Which payments vanish is decided on the server, not inferred here.**
 * Migration 212 stops a tenant reading a hidden contract's invoices, so a
 * payment that settled only that contract arrives with allocations that resolve
 * to nothing. An earlier version of this function treated any such payment as
 * hidden — which was wrong, and review round 3 on PR #209 caught it: an invoice
 * can also fail to resolve because an admin set `is_visible_to_tenant = false`,
 * nothing to do with roofs, and that payment must stay in the tenant's history.
 * The two are indistinguishable from here, so `portal_hidden_payment_ids`
 * (migration 214) answers it on the server and the answer arrives as
 * `hiddenPaymentIds`.
 *
 * An unallocated payment is never in that set: it is the tenant's own money
 * sitting unapplied, with no lease to be hidden by.
 *
 * `hiddenContractIds` does separate work — it strips the hidden *slice* from a
 * payment that settled a visible and a hidden lease together, which must
 * survive showing only what it put on the visible one.
 */
export function foldPortalPaymentAllocations(input: {
  allocations: readonly PortalFoldAllocation[];
  hiddenContractIds: ReadonlySet<string>;
  hiddenPaymentIds: ReadonlySet<string>;
  invoicesById: ReadonlyMap<string, PortalFoldInvoice>;
  paymentIds: readonly string[];
}): Map<string, PortalFoldResult | null> {
  const periodsByPayment = new Map<string, Map<string, PortalFoldPeriod>>();
  const contractsByPayment = new Map<string, Set<string>>();
  const sliceByPayment = new Map<string, Map<string, PortalFoldSlice & { keys: Set<string> }>>();
  const allocatedByPayment = new Map<string, number>();

  for (const allocation of input.allocations) {
    // Summed before the lookup, and deliberately including allocations whose
    // invoice will not resolve: that is what makes the unapplied remainder
    // computable for a payment partly settled onto a hidden lease.
    allocatedByPayment.set(
      allocation.payment_id,
      Math.round(
        ((allocatedByPayment.get(allocation.payment_id) ?? 0) + allocation.amount) * 1000,
      ) / 1000,
    );
    const invoice = input.invoicesById.get(allocation.invoice_id);
    if (!invoice) continue;
    if (input.hiddenContractIds.has(invoice.contract_id)) continue;

    const key = `${invoice.year}-${invoice.month}`;
    const period = { month: invoice.month, year: invoice.year };

    const bucket = periodsByPayment.get(allocation.payment_id) ?? new Map();
    bucket.set(key, period);
    periodsByPayment.set(allocation.payment_id, bucket);

    const contracts = contractsByPayment.get(allocation.payment_id) ?? new Set<string>();
    contracts.add(invoice.contract_id);
    contractsByPayment.set(allocation.payment_id, contracts);

    const slices = sliceByPayment.get(allocation.payment_id) ?? new Map();
    const slice = slices.get(invoice.contract_id) ?? { amount: 0, periods: [], keys: new Set() };
    // Kuwaiti dinar is 3-decimal; round the running sum so repeated float
    // addition cannot drift a fils away from what the receipt shows.
    slice.amount = roundToFils(slice.amount + allocation.amount);
    if (!slice.keys.has(key)) {
      slice.keys.add(key);
      slice.periods.push(period);
    }
    slices.set(invoice.contract_id, slice);
    sliceByPayment.set(allocation.payment_id, slices);
  }

  const folded = new Map<string, PortalFoldResult | null>();
  for (const paymentId of input.paymentIds) {
    // `null` means "drop this payment": every allocation it had settles a lease
    // the tenant cannot see. The server said so — this does not guess from an
    // empty resolution, which would also swallow a payment whose invoices are
    // merely flagged `is_visible_to_tenant = false`.
    if (input.hiddenPaymentIds.has(paymentId)) {
      folded.set(paymentId, null);
      continue;
    }
    const byContract: Record<string, PortalFoldSlice> = {};
    for (const [contractId, slice] of sliceByPayment.get(paymentId) ?? []) {
      byContract[contractId] = {
        amount: slice.amount,
        periods: [...slice.periods].sort(byPeriod),
      };
    }
    folded.set(paymentId, {
      allocatedAmount: allocatedByPayment.get(paymentId) ?? 0,
      byContract,
      contractIds: [...(contractsByPayment.get(paymentId) ?? [])],
      periods: [...(periodsByPayment.get(paymentId)?.values() ?? [])].sort(byPeriod),
    });
  }
  return folded;
}
