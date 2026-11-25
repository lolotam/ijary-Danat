import { describe, expect, it } from "vitest";

import { depositInvoiceOptions, type DepositInvoiceInput } from "@/lib/depositInvoiceOptions";
import type { InvoiceState } from "@/integrations/supabase/database.types";

/**
 * فاتورة اختبارية بفترة وحالة ورصيد.
 */
function invoice(
  periodMonth: number,
  state: InvoiceState,
  balance: number,
  periodYear = 2026,
): DepositInvoiceInput {
  return {
    id: `inv-${periodYear}-${periodMonth}`,
    code: `INV-${periodYear}${String(periodMonth).padStart(2, "0")}`,
    period_year: periodYear,
    period_month: periodMonth,
    state,
    balance,
  };
}

describe("depositInvoiceOptions", () => {
  it("orders by period regardless of the order it received", () => {
    const options = depositInvoiceOptions([
      invoice(3, "due", 100),
      invoice(1, "paid", 0),
      invoice(2, "paid", 0),
    ]);

    expect(options.map((option) => option.period_month)).toEqual([1, 2, 3]);
  });

  it("orders across a year boundary rather than by month alone", () => {
    const options = depositInvoiceOptions([invoice(1, "due", 100, 2027), invoice(12, "paid", 0)]);

    expect(options.map((option) => [option.period_year, option.period_month])).toEqual([
      [2026, 12],
      [2027, 1],
    ]);
  });

  it("blocks a cancelled or waived invoice", () => {
    const options = depositInvoiceOptions([
      invoice(1, "cancelled", 500),
      invoice(2, "waived", 500),
    ]);

    expect(options.map((option) => option.block)).toEqual(["terminal", "terminal"]);
  });

  // The database raises deposit_invoice_out_of_order for exactly this; the flag
  // is what stops the accountant reaching that error.
  it("allows the earliest outstanding invoice and blocks the ones after it", () => {
    const options = depositInvoiceOptions([
      invoice(1, "paid", 0),
      invoice(2, "overdue", 500),
      invoice(3, "due", 500),
      invoice(4, "due", 500),
    ]);

    expect(options.map((option) => option.block)).toEqual([null, null, "outOfOrder", "outOfOrder"]);
  });

  // Listing paid invoices is the point of the feature: the accountant may have
  // marked one paid before recording the deposit that paid it.
  it("leaves a fully paid invoice selectable", () => {
    const options = depositInvoiceOptions([invoice(1, "paid", 0), invoice(2, "paid", 0)]);

    expect(options.every((option) => option.block === null)).toBe(true);
  });

  it("does not block a later paid invoice behind an outstanding one", () => {
    const options = depositInvoiceOptions([invoice(1, "due", 500), invoice(2, "paid", 0)]);

    expect(options.map((option) => option.block)).toEqual([null, null]);
  });
});
