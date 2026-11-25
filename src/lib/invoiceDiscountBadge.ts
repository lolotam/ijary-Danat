import { formatKwd } from "@/lib/money";

/**
 * هل تحمل الفاتورة خصماً فعلياً؟ الصفر والفراغ لا يُعدّان خصماً.
 *
 * One predicate for every surface that prints a discount row or badge: the
 * tenant who reads "الخصم 0 KWD" assumes someone else got one, so the row is
 * withheld unless money was actually taken off.
 */
export function hasDiscount(value: number | string | null | undefined): boolean {
  if (value == null) return false;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0;
}

/**
 * يبني نص شارة الخصم داخل سجل الفاتورة، أو null إن لم يكن هناك خصم.
 *
 * Returning null is what keeps an undiscounted invoice visually unchanged —
 * no badge, and no extra column. Amount only, never a percentage.
 */
export function invoiceDiscountBadgeText(
  discount: number | string | null | undefined,
  label: string,
  locale: string,
): string | null {
  if (!hasDiscount(discount)) return null;
  return `${label} (${formatKwd(discount, locale)})`;
}
