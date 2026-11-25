import { describe, expect, it } from "vitest";

import type { InvoiceState } from "@/integrations/supabase/database.types";

import {
  isBulkSettleable,
  isPartialPaymentLocked,
  invoiceOptionsForPartialLink,
  isSettleableForPartialLink,
  markInvoicesPaidSequentially,
  orderForBulkSettle,
  type BulkSettleInvoice,
} from "./invoiceBulkSelection";

/**
 * يبني فاتورة بالحد الأدنى لحالات التعليم الجماعي.
 */
function invoice(
  overrides: Partial<BulkSettleInvoice> & { balance?: number; due_date?: string; id?: string },
): BulkSettleInvoice & { balance: number; due_date: string; id: string } {
  return {
    id: overrides.id ?? overrides.code ?? "inv",
    code: "INV-001",
    period_year: 2026,
    period_month: 1,
    state: "due",
    balance: 100,
    due_date: "2026-01-15",
    ...overrides,
  };
}

describe("isBulkSettleable", () => {
  it.each<[InvoiceState, boolean]>([
    ["due", true],
    ["overdue", true],
    ["partially_paid", true],
    ["cancelled", false],
    ["waived", false],
    ["paid", false],
  ])("%s is settleable: %s", (state, expected) => {
    expect(isBulkSettleable({ state })).toBe(expected);
  });

  it("excludes cancelled and waived even when a balance remains", () => {
    // The RPC would overwrite those states with `paid` on a leftover balance.
    expect(isBulkSettleable({ state: "cancelled" })).toBe(false);
    expect(isBulkSettleable({ state: "waived" })).toBe(false);
  });
});

describe("orderForBulkSettle", () => {
  it("orders by period year/month when that order disagrees with due_date", () => {
    // February is due first (irregular schedule); January is still the earlier
    // period, and that is the tuple migration 129 compares.
    const february = invoice({
      id: "feb",
      code: "INV-FEB",
      period_month: 2,
      due_date: "2026-01-05",
    });
    const january = invoice({
      id: "jan",
      code: "INV-JAN",
      period_month: 1,
      due_date: "2026-02-20",
    });

    const byDueDate = [february, january].sort((left, right) =>
      left.due_date.localeCompare(right.due_date),
    );
    expect(byDueDate.map((row) => row.code)).toEqual(["INV-FEB", "INV-JAN"]);
    expect(orderForBulkSettle([february, january]).map((row) => row.code)).toEqual([
      "INV-JAN",
      "INV-FEB",
    ]);
  });

  it("does not mutate the caller's array", () => {
    const rows = [invoice({ code: "B", period_month: 2 }), invoice({ code: "A", period_month: 1 })];
    orderForBulkSettle(rows);
    expect(rows.map((row) => row.code)).toEqual(["B", "A"]);
  });
});

describe("markInvoicesPaidSequentially", () => {
  it("counts a resolved false as a failure, not a success", async () => {
    const rows = [
      invoice({ code: "INV-OK", period_month: 1 }),
      invoice({ code: "INV-FAIL", period_month: 2 }),
    ];
    const result = await markInvoicesPaidSequentially(rows, "bank_transfer", async (row) => {
      return row.code === "INV-OK";
    });
    expect(result).toEqual({ ok: 1, failedCodes: ["INV-FAIL"], firstError: null });
  });

  /**
   * Reported 2026-08-29 on tenant DANA-000049, whose contract's oldest payable
   * invoice is 2022-06: settling any later selection is refused by
   * `set_invoice_paid` with "Invoices must be paid in chronological order", and
   * the loop discarded that error. The toast then listed codes with no cause,
   * which reads as a broken button rather than an instruction.
   */
  it("keeps the error a rejected invoice failed with, so the toast can name the cause", async () => {
    const refusal = new Error("Invoices must be paid in chronological order.");

    const result = await markInvoicesPaidSequentially(
      [invoice({ code: "INV-AUG", period_month: 8 })],
      "bank_transfer",
      async () => {
        throw refusal;
      },
    );

    expect(result.firstError).toBe(refusal);
    expect(result.failedCodes).toEqual(["INV-AUG"]);
    expect(result.ok).toBe(0);
  });

  it("keeps the first rejection and still settles the invoices after it", async () => {
    const first = new Error("Invoices must be paid in chronological order.");
    const second = new Error("something else entirely");

    const result = await markInvoicesPaidSequentially(
      [
        invoice({ code: "INV-JAN", period_month: 1 }),
        invoice({ code: "INV-FEB", period_month: 2 }),
        invoice({ code: "INV-MAR", period_month: 3 }),
      ],
      "bank_transfer",
      async (row) => {
        if (row.code === "INV-JAN") throw first;
        if (row.code === "INV-FEB") throw second;
        return true;
      },
    );

    // One throw must not abort the batch, and the cause reported is the one the
    // admin can act on rather than whatever failed last.
    expect(result.firstError).toBe(first);
    expect(result.ok).toBe(1);
    expect(result.failedCodes).toEqual(["INV-JAN", "INV-FEB"]);
  });

  it("reports the newer invoice as failed when the older period is refused", async () => {
    // Migration 129 refuses February while January is still payable. The older
    // row is refused here; February must not be silently counted `ok`.
    const january = invoice({ code: "INV-JAN", period_month: 1, period_year: 2026 });
    const february = invoice({ code: "INV-FEB", period_month: 2, period_year: 2026 });
    const stillPayable = new Set(["INV-JAN", "INV-FEB"]);

    const result = await markInvoicesPaidSequentially(
      [february, january],
      "bank_transfer",
      async (row) => {
        const earlierStillOpen = [...stillPayable].some((code) => {
          const other = code === "INV-JAN" ? january : february;
          return (
            other.period_year < row.period_year ||
            (other.period_year === row.period_year && other.period_month < row.period_month)
          );
        });
        if (earlierStillOpen) return false;
        if (row.code === "INV-JAN") return false;
        stillPayable.delete(row.code);
        return true;
      },
    );

    expect(result.ok).toBe(0);
    expect(result.failedCodes).toEqual(["INV-JAN", "INV-FEB"]);
    // Refused by returning false, not by throwing — there is no error to keep.
    expect(result.firstError).toBeNull();
  });
});

describe("isSettleableForPartialLink", () => {
  it("keeps due/overdue/partially_paid with a remaining balance", () => {
    expect(isSettleableForPartialLink({ state: "due", balance: 1 })).toBe(true);
    expect(isSettleableForPartialLink({ state: "overdue", balance: 10 })).toBe(true);
    expect(isSettleableForPartialLink({ state: "partially_paid", balance: 0.001 })).toBe(true);
  });

  it("drops paid, cancelled, waived, and zero-balance rows", () => {
    expect(isSettleableForPartialLink({ state: "paid", balance: 5 })).toBe(false);
    expect(isSettleableForPartialLink({ state: "cancelled", balance: 50 })).toBe(false);
    expect(isSettleableForPartialLink({ state: "waived", balance: 50 })).toBe(false);
    expect(isSettleableForPartialLink({ state: "due", balance: 0 })).toBe(false);
  });
});

describe("invoiceOptionsForPartialLink", () => {
  const due = { id: "due", code: "INV-DUE", state: "due" as const, balance: 50 };
  const paid = { id: "paid", code: "INV-PAID", state: "paid" as const, balance: 0 };

  it("offers only settleable invoices when nothing is pinned", () => {
    expect(invoiceOptionsForPartialLink([paid, due]).map((row) => row.code)).toEqual(["INV-DUE"]);
  });

  it("keeps a pinned current invoice among the options even when it is paid", () => {
    expect(invoiceOptionsForPartialLink([paid, due], paid).map((row) => row.code)).toEqual([
      "INV-PAID",
      "INV-DUE",
    ]);
  });
});

describe("isPartialPaymentLocked", () => {
  it("locks only a complete row that still names an invoice", () => {
    expect(isPartialPaymentLocked({ status: "complete", invoice_id: "inv-1" })).toBe(true);
    expect(isPartialPaymentLocked({ status: "complete", invoice_id: null })).toBe(false);
    expect(isPartialPaymentLocked({ status: "incomplete", invoice_id: "inv-1" })).toBe(false);
  });
});
