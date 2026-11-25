import { describe, expect, it } from "vitest";

import type { SettleableInvoice } from "./invoiceSettlement";
import {
  buildInvoiceSettlements,
  compareInvoicePeriod,
  deselectFrom,
  findOutOfOrderAllocation,
  isContiguousPrefix,
  nextSelectableIndex,
  selectThrough,
  settleableInvoices,
  settlementTotal,
} from "./invoiceSettlement";

/** Defaults first, overrides last — a `??` per field would be silently lost to the spread below it. */
function invoice(
  overrides: Partial<SettleableInvoice> & Pick<SettleableInvoice, "id" | "balance">,
): SettleableInvoice {
  return {
    code: overrides.id,
    period_month: 1,
    period_year: 2026,
    state: "due",
    ...overrides,
  };
}

describe("settleableInvoices", () => {
  it("excludes cancelled, waived, and zero-balance invoices", () => {
    const result = settleableInvoices([
      invoice({ id: "a", balance: 100, state: "due" }),
      invoice({ id: "b", balance: 50, state: "cancelled" }),
      invoice({ id: "c", balance: 50, state: "waived" }),
      invoice({ id: "d", balance: 0, state: "paid" }),
      invoice({ id: "e", balance: 25, state: "partially_paid" }),
      invoice({ id: "f", balance: 10, state: "overdue" }),
    ]);
    expect(result.map((row) => row.id)).toEqual(["a", "e", "f"]);
  });

  it("orders oldest period first across a year boundary, with code as same-period tiebreaker", () => {
    const result = settleableInvoices([
      invoice({ id: "new", code: "INV-003", balance: 1, period_month: 1, period_year: 2026 }),
      invoice({ id: "late", code: "INV-002", balance: 1, period_month: 12, period_year: 2025 }),
      invoice({ id: "early", code: "INV-001", balance: 1, period_month: 12, period_year: 2025 }),
    ]);
    expect(result.map((row) => row.id)).toEqual(["early", "late", "new"]);
  });

  it("leaves the caller's array unsorted", () => {
    const invoices = [
      invoice({ id: "b", balance: 1, period_month: 2, period_year: 2026 }),
      invoice({ id: "a", balance: 1, period_month: 1, period_year: 2026 }),
    ];
    settleableInvoices(invoices);
    expect(invoices.map((row) => row.id)).toEqual(["b", "a"]);
  });
});

describe("buildInvoiceSettlements", () => {
  it("sets each settlement amount to the invoice full balance", () => {
    const invoices = [
      invoice({ id: "a", balance: 120.5, period_month: 1, period_year: 2026 }),
      invoice({ id: "b", balance: 99.999, period_month: 2, period_year: 2026 }),
    ];
    expect(buildInvoiceSettlements(invoices, ["b", "a"])).toEqual([
      { invoiceId: "a", amount: 120.5 },
      { invoiceId: "b", amount: 99.999 },
    ]);
  });

  it("drops a selected invoice the allocation RPC would refuse", () => {
    const invoices = [
      invoice({ id: "ok", balance: 10, period_month: 1, period_year: 2026 }),
      invoice({ id: "void", balance: 10, state: "cancelled", period_month: 2, period_year: 2026 }),
    ];
    expect(buildInvoiceSettlements(invoices, ["ok", "void"])).toEqual([
      { invoiceId: "ok", amount: 10 },
    ]);
  });

  it("ignores selected ids that match no settleable invoice and never emits NaN", () => {
    const invoices = [invoice({ id: "a", balance: 10, state: "due" })];
    const result = buildInvoiceSettlements(invoices, ["missing", "a", "also-missing"]);
    expect(result).toEqual([{ invoiceId: "a", amount: 10 }]);
    expect(result.every((row) => Number.isFinite(row.amount))).toBe(true);
  });
});

describe("settlementTotal", () => {
  it("sums balances without float drift for fils-scale amounts", () => {
    expect(
      settlementTotal([
        { invoiceId: "a", amount: 0.001 },
        { invoiceId: "b", amount: 0.001 },
        { invoiceId: "c", amount: 0.001 },
      ]),
    ).toBe(0.003);
    expect(
      settlementTotal([
        { invoiceId: "a", amount: 0.1 },
        { invoiceId: "b", amount: 0.2 },
      ]),
    ).toBe(0.3);
  });
});

describe("contiguous-prefix selection", () => {
  const rows = [{ id: "jan" }, { id: "feb" }, { id: "mar" }];

  describe("isContiguousPrefix", () => {
    it.each([
      { selected: [], valid: true, why: "an empty selection" },
      { selected: ["jan"], valid: true, why: "the oldest alone" },
      { selected: ["jan", "feb", "mar"], valid: true, why: "all of them" },
      { selected: ["feb", "jan"], valid: true, why: "a prefix given out of order" },
      { selected: ["feb"], valid: false, why: "skipping the oldest" },
      { selected: ["jan", "mar"], valid: false, why: "a gap in the middle" },
      { selected: ["jan", "apr"], valid: false, why: "an id absent from the list" },
      { selected: ["jan", "jan"], valid: false, why: "a duplicated id" },
      { selected: ["jan", "feb", "mar", "apr"], valid: false, why: "more selected than exist" },
    ])("$why is ${valid} a prefix", ({ selected, valid }) => {
      expect(isContiguousPrefix(rows, selected)).toBe(valid);
    });

    it("an empty list accepts only an empty selection", () => {
      expect(isContiguousPrefix([], [])).toBe(true);
      expect(isContiguousPrefix([], ["jan"])).toBe(false);
    });
  });

  describe("selectThrough and deselectFrom", () => {
    it.each([
      { index: 0, through: ["jan"], from: [] },
      { index: 1, through: ["jan", "feb"], from: ["jan"] },
      { index: 2, through: ["jan", "feb", "mar"], from: ["jan", "feb"] },
    ])("row $index ticks to $through and unticks to $from", ({ index, through, from }) => {
      expect(selectThrough(rows, index)).toEqual(through);
      expect(deselectFrom(rows, index)).toEqual(from);
    });

    it("neither can produce a selection the prefix rule would reject", () => {
      for (let index = 0; index < rows.length; index += 1) {
        expect(isContiguousPrefix(rows, selectThrough(rows, index))).toBe(true);
        expect(isContiguousPrefix(rows, deselectFrom(rows, index))).toBe(true);
      }
    });
  });

  describe("nextSelectableIndex", () => {
    it.each([
      { selected: [], next: 0, why: "nothing selected offers only the oldest" },
      { selected: ["jan"], next: 1, why: "it advances as the prefix grows" },
      { selected: ["jan", "feb"], next: 2, why: "it keeps advancing" },
      { selected: ["jan", "feb", "mar"], next: 3, why: "everything selected leaves no next row" },
      { selected: ["mar"], next: 0, why: "an invalid selection falls back to the oldest" },
    ])("$why", ({ selected, next }) => {
      expect(nextSelectableIndex(rows, selected)).toBe(next);
    });
  });
});

describe("compareInvoicePeriod", () => {
  it("orders by year, then month, then code — the same answer on every screen", () => {
    const rows = [
      { code: "INV-9", period_year: 2026, period_month: 2 },
      { code: "INV-2", period_year: 2026, period_month: 1 },
      { code: "INV-1", period_year: 2026, period_month: 1 },
      { code: "INV-5", period_year: 2025, period_month: 12 },
    ];
    // Shuffled input orders must not change the result: two invoices in the same
    // period used to sort in arrival order on two of the three screens.
    const forward = [...rows].sort(compareInvoicePeriod).map((row) => row.code);
    const backward = [...rows]
      .reverse()
      .sort(compareInvoicePeriod)
      .map((row) => row.code);
    expect(forward).toEqual(["INV-5", "INV-1", "INV-2", "INV-9"]);
    expect(backward).toEqual(forward);
  });
});

describe("findOutOfOrderAllocation", () => {
  const open = [
    invoice({ id: "jan", balance: 100, period_month: 1 }),
    invoice({ id: "feb", balance: 100, period_month: 2 }),
    invoice({ id: "mar", balance: 100, period_month: 3 }),
  ];

  it("accepts settling the oldest open invoice in full", () => {
    expect(findOutOfOrderAllocation(open, [{ invoice_id: "jan", amount: 100 }])).toBeNull();
  });

  it("accepts a contiguous run that clears each older month before the next", () => {
    expect(
      findOutOfOrderAllocation(open, [
        { invoice_id: "jan", amount: 100 },
        { invoice_id: "feb", amount: 40 },
      ]),
    ).toBeNull();
  });

  it("refuses skipping an older open month — the admin-path hole the browser alone guarded", () => {
    expect(findOutOfOrderAllocation(open, [{ invoice_id: "feb", amount: 100 }])).toBe("feb");
  });

  it("refuses a newer month while the older one is only partly paid in the same call", () => {
    expect(
      findOutOfOrderAllocation(open, [
        { invoice_id: "jan", amount: 60 },
        { invoice_id: "feb", amount: 10 },
      ]),
    ).toBe("feb");
  });

  it("treats invoices of the same period as peers, like set_invoice_paid_chronological", () => {
    // Migration 129 compares the (year, month) tuple only, so a same-month
    // sibling is never "older". The server must not be stricter than the SQL
    // authority or it would refuse settlements the database accepts.
    const siblings = [
      invoice({ id: "rent", code: "INV-1", balance: 100, period_month: 1 }),
      invoice({ id: "power", code: "INV-2", balance: 30, period_month: 1 }),
    ];
    expect(findOutOfOrderAllocation(siblings, [{ invoice_id: "power", amount: 30 }])).toBeNull();
  });

  it("ignores a paid-off older month, which is not open", () => {
    const withPaidJan = [invoice({ id: "jan", balance: 0, period_month: 1 }), ...open.slice(1)];
    expect(findOutOfOrderAllocation(withPaidJan, [{ invoice_id: "feb", amount: 100 }])).toBeNull();
  });

  it("judges each invoice only against its own contract's older months", () => {
    // Codex review, PR #220: one payment split across two contracts pooled
    // their invoices, so contract A's open January blocked contract B's
    // February. Migration 129's rule is per contract.
    const twoContracts = [
      { ...invoice({ id: "a-jan", balance: 100, period_month: 1 }), contract_id: "A" },
      { ...invoice({ id: "b-feb", balance: 100, period_month: 2 }), contract_id: "B" },
    ];
    expect(
      findOutOfOrderAllocation(twoContracts, [{ invoice_id: "b-feb", amount: 100 }]),
    ).toBeNull();
  });

  it("does not let float dust on the older month block the next one", () => {
    const dusty = [
      invoice({ id: "jan", balance: 0.3, period_month: 1 }),
      invoice({ id: "feb", balance: 50, period_month: 2 }),
    ];
    expect(
      findOutOfOrderAllocation(dusty, [
        { invoice_id: "jan", amount: 0.1 + 0.2 },
        { invoice_id: "feb", amount: 50 },
      ]),
    ).toBeNull();
  });
});
