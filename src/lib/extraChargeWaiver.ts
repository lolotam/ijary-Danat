import { roundToFils } from "@/lib/fils";

/** ما يحتاجه الفحص من الفاتورة، لا أكثر — حتى يبقى قابلاً للاختبار بلا استعلام. */
export interface WaiverCandidate {
  id: string;
  /** إجمالي الفاتورة قبل الخصم. */
  subtotal: number;
  /** مجموع بنود المصروفات الدورية على الفاتورة. */
  extraCharges: number;
}

/** التنازل المطبَّق، بالشكل الذي يخزّنه الجدول. */
export type WaiverConcession =
  | { type: "percentage_discount"; percent: number }
  | { type: "fixed_discount"; amount: number };

/**
 * يحدّد الفواتير التي يُسأل المسؤول عن إسقاط مصروفاتها الدورية.
 *
 * A month qualifies when the discount swallows its rent ENTIRELY and there is
 * still a service charge left standing. That is the situation the operator
 * described: the month has been made free "by any means", so the app should ask
 * whether the charges go too rather than quietly billing them.
 *
 * Both discount types are capped at the rent (migration 171), so `rent - taken`
 * reaching exactly zero is the same test for each and no invoice can arrive
 * here already part-way into its charges.
 *
 * This decides only what to SHOW. `apply_concession_to_invoices` re-derives all
 * of it under the row lock and ignores an id that no longer qualifies — the
 * screen may be stale by the time the operator answers, and a waiver granted on
 * a misread month is money forgiven that nobody agreed to forgive.
 */
export function invoicesNeedingWaiverPrompt<T extends WaiverCandidate>(
  invoices: readonly T[],
  concession: WaiverConcession,
): T[] {
  return invoices.filter((invoice) => {
    const rent = invoice.subtotal - invoice.extraCharges;
    // No rent to forgive means there is nothing to be "fully" discounted, and a
    // month with no charges has nothing to waive.
    if (rent <= 0 || invoice.extraCharges <= 0) return false;
    const taken =
      concession.type === "percentage_discount"
        ? roundToFils((rent * concession.percent) / 100)
        : Math.min(rent, concession.amount);
    return roundToFils(rent - taken) === 0;
  });
}
