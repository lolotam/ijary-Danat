/**
 * يحوّل رسائل أخطاء قاعدة البيانات الخاصة بالدفعات الجزئية إلى مفاتيح ترجمة.
 *
 * Migration 160 raises named exceptions rather than returning a flag, so they
 * reach the browser as raw PostgREST strings. Without this the admin reads a
 * Postgres identifier.
 *
 * Returns null rather than a generic key so the caller keeps whatever fallback
 * it already had: mapping an unrecognised failure to a partial-payment message
 * would explain the wrong thing, and swallowing it entirely is how a real
 * failure becomes invisible.
 */
const ERROR_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["partial_payment_exceeds_balance", "partialPayments.exceedsBalance"],
  ["partial_payment_invoice_out_of_order", "partialPayments.outOfOrder"],
  ["partial_payment_invoice_terminal_state", "partialPayments.invoiceTerminal"],
  ["partial_payment_settled_immutable", "partialPayments.settledImmutable"],
  ["partial_payment_bulk_edit_unsupported", "partialPayments.bulkUnsupported"],
  ["40P01", "partialPayments.retry"],
  ["deadlock detected", "partialPayments.retry"],
];

export function partialPaymentErrorKey(
  error: { message?: string; code?: string } | null | undefined,
): string | null {
  const message = error?.message;
  const code = error?.code;
  if (code === "40P01") return "partialPayments.retry";
  if (!message) return null;
  return ERROR_KEYS.find(([token]) => message.includes(token))?.[1] ?? null;
}
