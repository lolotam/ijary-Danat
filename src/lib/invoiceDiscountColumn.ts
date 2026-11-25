import { formatKwd } from "@/lib/money";
import { hasDiscount } from "@/lib/invoiceDiscountBadge";

/** التنازل المرتبط بفاتورة، بالشكل الذي يحتاجه عمود الخصم. */
export interface LinkedConcession {
  type: string;
  discount_percent: number | null;
}

export type InvoiceDiscountBadge =
  | { kind: "fixed"; amount: string }
  | { kind: "percentage"; percent: number; amount: string };

/**
 * يبني شارة الخصم، أو null إن لم يكن هناك خصم مطبَّق.
 *
 * Returns null rather than a zero badge so an undiscounted row keeps the page's
 * existing empty treatment. The AMOUNT is always money that was applied — an
 * invoice's own `discount` column, or the total of those columns across the
 * invoices a concession covers — and is never recomputed from the percentage:
 * the invoice is what the tenant owes, and a rounding difference between the
 * two would show a number the tenant was never charged.
 *
 * Both callers pass their own row as `concession`: an invoice passes the
 * concession that discounted it, the concessions dialog passes itself. Same
 * rule, same rendering, so the screen where a discount is configured and the
 * screen where it is checked cannot disagree.
 *
 * The badge carries no month count. The Discount column is a financial column;
 * how many invoices a concession spans is a property of the concession, shown
 * beside it in `ConcessionsDialog`, not repeated on every invoice row.
 */
export function invoiceDiscountBadge(
  discount: number | null | undefined,
  concession: LinkedConcession | null | undefined,
  locale: string,
): InvoiceDiscountBadge | null {
  if (!hasDiscount(discount)) return null;
  const amount = formatKwd(discount, locale);

  if (concession?.type === "percentage_discount" && concession.discount_percent != null) {
    return { kind: "percentage", percent: Number(concession.discount_percent), amount };
  }
  // Anything else — a fixed discount, or a legacy row whose link the backfill
  // could not resolve — renders as an amount. A discount that exists on the
  // invoice is never hidden just because its concession is unknown.
  return { kind: "fixed", amount };
}
