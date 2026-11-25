import type { InvoiceActionInput } from "@/lib/closeoutSchemas";

/**
 * الإجراء الافتراضي لفاتورة في معالج إنهاء العقد: شطب ما بعد شهر الإخلاء.
 *
 * The operator closing CON-00026 expected every future month gone and had to
 * flip 40 radios by hand; the one they missed stayed `due`. The wizard still
 * lets every row be changed — this only chooses the starting point.
 */
export function defaultInvoiceAction(
  invoice: { period_year: number; period_month: number; state: string },
  moveOutDate: string,
): "leave" | "write_off" {
  // A cancelled or waived month keeps a positive balance, so it is listed
  // with the unpaid rows — but closeout_compute_settlement refuses to write
  // off either terminal state, and a seeded write_off would fail the submit.
  if (invoice.state === "cancelled" || invoice.state === "waived") return "leave";
  const match = /^(\d{4})-(\d{2})/.exec(moveOutDate);
  if (!match) return "leave";
  const moveOutKey = Number(match[1]) * 12 + Number(match[2]);
  const periodKey = invoice.period_year * 12 + invoice.period_month;
  return periodKey > moveOutKey ? "write_off" : "leave";
}

/**
 * يعيد بذر الصفوف التي لم يلمسها المشغّل عند تغيير تاريخ الإخلاء.
 *
 * The seed runs when invoices load, against the default (today's) date. A
 * backdated move-out entered afterwards must move the write-off boundary for
 * every row the operator has not decided by hand, and only those.
 */
export function reseedUntouched(
  rows: InvoiceActionInput[],
  invoices: Array<{ id: string; period_year: number; period_month: number; state: string }>,
  moveOutDate: string,
  touched: ReadonlySet<string>,
): InvoiceActionInput[] {
  const byId = new Map(invoices.map((invoice) => [invoice.id, invoice] as const));
  return rows.map((row) => {
    if (touched.has(row.invoice_id)) return row;
    const invoice = byId.get(row.invoice_id);
    if (!invoice) return row;
    return { ...row, action: defaultInvoiceAction(invoice, moveOutDate), amount: 0 };
  });
}
