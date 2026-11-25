import { describe, expect, it } from "vitest";

import type { InvoicePaymentBreakdown } from "./invoicePaymentBreakdown";
import { describeBreakdown, parseInvoicePaymentBreakdown } from "./invoicePaymentBreakdown";

/**
 * لقطة سداد جاهزة للاختبار، بأرقام فاتورة 3000 سُدّدت بالكامل من مصدرين.
 */
function paidBreakdown(overrides: Partial<InvoicePaymentBreakdown> = {}): InvoicePaymentBreakdown {
  return {
    invoice: {
      code: "INV-1",
      subtotal: 3000,
      discount: 0,
      total: 3000,
      paid: 3000,
      balance: 0,
      state: "paid",
    },
    paid_from_allocations: 3000,
    reconciled: true,
    groups: [
      {
        source: "partial",
        method: "cash",
        amount: 1000,
        first_paid_on: "2026-01-10",
        last_paid_on: "2026-01-10",
        payments: 1,
      },
      {
        source: "gateway",
        method: "knet",
        amount: 2000,
        first_paid_on: "2026-01-15",
        last_paid_on: "2026-01-15",
        payments: 1,
      },
    ],
    ...overrides,
  };
}

describe("parseInvoicePaymentBreakdown last_paid_on", () => {
  it("falls back to the first payment date for a snapshot from before migration 227", () => {
    const parsed = parseInvoicePaymentBreakdown({
      invoice: paidBreakdown().invoice,
      paid_from_allocations: 3000,
      reconciled: true,
      groups: [
        {
          source: "manual",
          method: "cash",
          amount: "3000",
          first_paid_on: "2026-01-10",
          payments: 1,
        },
      ],
    });

    expect(parsed.groups[0].last_paid_on).toBe("2026-01-10");
  });
});

describe("describeBreakdown", () => {
  it("keeps the RPC's group order and labels each provenance", () => {
    const described = describeBreakdown(paidBreakdown(), "en");
    expect(described.groupRows.map((row) => row.label)).toEqual([
      "Partial payment (Cash)",
      "Payment link (KNET)",
    ]);
    expect(described.groupRows.map((row) => row.amount)).toEqual([1000, 2000]);
  });

  it("counts distinct methods, not groups", () => {
    const described = describeBreakdown(
      paidBreakdown({
        groups: [
          {
            source: "partial",
            method: "cash",
            amount: 1000,
            first_paid_on: "2026-01-10",
            last_paid_on: "2026-01-10",
            payments: 1,
          },
          {
            source: "manual",
            method: "cash",
            amount: 2000,
            first_paid_on: "2026-01-12",
            last_paid_on: "2026-01-12",
            payments: 1,
          },
        ],
      }),
      "en",
    );
    expect(described.distinctMethodCount).toBe(1);
    expect(described.statusLine).toBe("Paid in full");
  });

  it("uses the Arabic dual for two methods and the plural for more", () => {
    expect(describeBreakdown(paidBreakdown(), "ar").statusLine).toBe(
      "مدفوعة بالكامل، بطريقتَي دفع",
    );
    const three = paidBreakdown({
      groups: [
        ...paidBreakdown().groups,
        {
          source: "manual",
          method: "card",
          amount: 0,
          first_paid_on: "2026-01-20",
          last_paid_on: "2026-01-20",
          payments: 1,
        },
      ],
    });
    expect(describeBreakdown(three, "ar").statusLine).toBe("مدفوعة بالكامل، باستخدام 3 طرق دفع");
    expect(describeBreakdown(three, "en").statusLine).toBe("Paid in full, using 3 payment methods");
  });

  it("escapes nothing itself — labels are plain text for the renderer to esc()", () => {
    const described = describeBreakdown(
      paidBreakdown({
        groups: [
          {
            source: "manual",
            method: "<script>",
            amount: 10,
            first_paid_on: "2026-01-01",
            last_paid_on: "2026-01-01",
            payments: 1,
          },
        ],
      }),
      "en",
    );
    expect(described.groupRows[0].label).toContain("<script>");
    expect(described.groupRows[0].label).not.toContain("&lt;");
  });

  it("withholds the breakdown and the method count when reconciled is false", () => {
    const described = describeBreakdown(paidBreakdown({ reconciled: false }), "en");
    expect(described.showBreakdown).toBe(false);
    expect(described.groupRows).toEqual([]);
    expect(described.distinctMethodCount).toBe(0);
    expect(described.statusLine).toBe("Paid in full");
  });

  it("names cancelled, waived, zero-total, partial and unpaid states", () => {
    expect(
      describeBreakdown(
        paidBreakdown({ invoice: { ...paidBreakdown().invoice, state: "cancelled" } }),
        "en",
      ).statusLine,
    ).toBe("Cancelled");
    expect(
      describeBreakdown(
        paidBreakdown({ invoice: { ...paidBreakdown().invoice, state: "waived" } }),
        "en",
      ).statusLine,
    ).toBe("Written off");
    expect(
      describeBreakdown(
        paidBreakdown({
          invoice: { ...paidBreakdown().invoice, total: 0, paid: 0, state: "due" },
        }),
        "en",
      ).statusLine,
    ).toBe("Nothing due");
    expect(
      describeBreakdown(
        paidBreakdown({
          invoice: {
            ...paidBreakdown().invoice,
            state: "partially_paid",
            paid: 1000,
            balance: 2000,
          },
        }),
        "en",
      ).statusLine,
    ).toMatch(/Partially paid/);
    expect(
      describeBreakdown(
        paidBreakdown({
          invoice: {
            ...paidBreakdown().invoice,
            state: "due",
            paid: 0,
            balance: 3000,
          },
          groups: [],
        }),
        "en",
      ).statusLine,
    ).toBe("Unpaid");
  });

  // An overdue invoice that received a partial payment keeps state `overdue`
  // (migrations 217/218); the document must still say partially paid.
  it("names an overdue invoice with a partial payment as partially paid, not unpaid", () => {
    expect(
      describeBreakdown(
        paidBreakdown({
          invoice: { ...paidBreakdown().invoice, state: "overdue", paid: 350, balance: 350 },
        }),
        "en",
      ).statusLine,
    ).toMatch(/Partially paid/);
  });
});
