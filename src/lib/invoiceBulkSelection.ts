import type { InvoiceState } from "@/integrations/supabase/database.types";
import { compareInvoicePeriod } from "@/lib/invoiceSettlement";

/**
 * الحالات التي يجوز تعليمها كمدفوعة دفعة واحدة.
 *
 * Explicit allow-list, not "anything unpaid": `set_invoice_paid` only checks
 * the remaining balance before writing `paid`, so admitting `cancelled` or
 * `waived` would resurrect a written-off invoice and book a real payment.
 */
const BULK_SETTLEABLE_STATES: ReadonlySet<InvoiceState> = new Set([
  "due",
  "overdue",
  "partially_paid",
]);

/** الحد الأدنى الذي تحتاجه حلقة التعليم الجماعي: الحالة والفترة والكود. */
export type BulkSettleInvoice = {
  code: string;
  period_month: number;
  period_year: number;
  state: InvoiceState;
};

/**
 * يقرر إن كانت الفاتورة قابلة للاختيار في التعليم الجماعي كمدفوعة.
 */
export function isBulkSettleable(invoice: { state: InvoiceState }): boolean {
  return BULK_SETTLEABLE_STATES.has(invoice.state);
}

/**
 * يرتّب الفواتير المختارة بسنة/شهر الفترة تصاعديًا، لا بتاريخ الاستحقاق.
 *
 * Migration 129 (`set_invoice_paid_chronological`) refuses to settle a row
 * while an earlier period on the same contract is still payable, and compares
 * the `(period_year, period_month)` tuple so January always precedes February
 * regardless of due-date quirks. Sorting the bulk loop by `due_date` would
 * look right and still fail on an irregular schedule.
 */
export function orderForBulkSettle<
  T extends { code: string; period_month: number; period_year: number },
>(invoices: readonly T[]): T[] {
  // The shared comparator adds the `code` tiebreak this loop lacked, so two
  // invoices in one period settle in the same order on every run (audit H8).
  return [...invoices].sort(compareInvoicePeriod);
}

/**
 * حالة خانة رأس الجدول: محددة بالكامل، أو جزئيًا، أو فارغة.
 */
export function bulkSelectionHeaderState(
  selectableIds: readonly string[],
  selectedIds: ReadonlySet<string>,
): boolean | "indeterminate" {
  if (selectableIds.length === 0) return false;
  const selectedOnPage = selectableIds.filter((id) => selectedIds.has(id)).length;
  if (selectedOnPage === 0) return false;
  if (selectedOnPage === selectableIds.length) return true;
  return "indeterminate";
}

/**
 * يعلّم الفواتير المختارة واحدة تلو الأخرى بالترتيب الزمني للفترة، ويحتفظ بسبب أول إخفاق.
 *
 * A `false` return and a rejection are both failures — counting only rejections
 * would report every `false` as a success, and counting only `false` would let
 * one unexpected throw abort the batch.
 *
 * `firstError` exists because the reason mattered and was being thrown away.
 * `set_invoice_paid` refuses an invoice while an earlier period on the same
 * contract is still payable, and that refusal is the whole explanation an admin
 * needs — without it the toast listed codes and no cause, which read as "the
 * button is broken". The first is kept rather than all of them: one blocking
 * invoice fails every later selection for the same reason.
 */
export async function markInvoicesPaidSequentially<T extends BulkSettleInvoice>(
  invoices: readonly T[],
  reason: string,
  markOne: (invoice: T, reason: string) => Promise<boolean>,
): Promise<{ failedCodes: string[]; firstError: unknown; ok: number }> {
  let ok = 0;
  const failedCodes: string[] = [];
  let firstError: unknown = null;
  for (const invoice of orderForBulkSettle(invoices)) {
    let marked: boolean;
    try {
      marked = await markOne(invoice, reason);
    } catch (error) {
      firstError ??= error;
      marked = false;
    }
    if (marked) ok += 1;
    else failedCodes.push(invoice.code);
  }
  return { failedCodes, firstError, ok };
}

/**
 * فاتورة يجوز ربطها بدفعة جزئية: قابلة للتسوية وفيها رصيد.
 *
 * Same settleable states as bulk mark-paid, plus a remaining balance — a
 * zero-balance row has nothing left for the note to describe.
 */
export function isSettleableForPartialLink(invoice: {
  balance: number;
  state: InvoiceState;
}): boolean {
  return isBulkSettleable(invoice) && invoice.balance > 0;
}

/**
 * خيارات فاتورة حوار الدفعة الجزئية: القابلة للتسوية، مع الفاتورة الحالية دائمًا.
 *
 * D4 keeps the row's own invoice in the list even after it became `paid`, so
 * the accountant can still see (and keep) the link they are editing.
 */
export function invoiceOptionsForPartialLink<
  T extends { balance: number; id: string; state: InvoiceState },
>(invoices: readonly T[], pinnedInvoice?: T | null): T[] {
  const options = invoices.filter(isSettleableForPartialLink);
  if (pinnedInvoice && !options.some((invoice) => invoice.id === pinnedInvoice.id)) {
    options.unshift(pinnedInvoice);
  }
  return options;
}

/**
 * يقرر إن كان صف الدفعة الجزئية مقفلاً لأن النظام أغلقه بربط فاتورة مسدّدة.
 *
 * A complete row with no invoice stays editable: the admin set that status by
 * hand and nothing has overruled them.
 */
export function isPartialPaymentLocked(row: { invoice_id?: unknown; status?: unknown }): boolean {
  return (
    row.status === "complete" && typeof row.invoice_id === "string" && row.invoice_id.length > 0
  );
}
