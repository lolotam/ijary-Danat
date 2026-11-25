import { describe, expect, test } from "vitest";

import {
  buildPaymentDocument,
  hasWithheldAllocations,
  settledInvoicesOf,
} from "@/lib/paymentPrintDocument";

/**
 * ورقة الدفعة يجب أن تكون واحدة في الإدارة والبوابة معاً.
 *
 * Regression test (found 2026-09-03): `/admin/payments` always printed the
 * payment *receipt*, while the portal's payment row printed the *invoice* sheet
 * whenever the payment settled invoices. The same paid invoice therefore came
 * out as two different documents, and the admin one matched neither
 * `/admin/invoices` nor the tenant's Monthly Invoices section.
 *
 * Asserted on which document actually came back — the invoice branch is named
 * after the invoice codes, the receipt branch after the receipt — rather than on
 * a builder having been called, which would pass for either.
 */
const payment = {
  amount: 1400,
  code: "PAY-0001",
  currency: "KWD",
  id: "pay-1",
  payment_date: "2026-01-15",
  tenant_id: "tenant-1",
} as never;

const receipt = {
  amount: 1400,
  code: "REC-0009",
  currency: "KWD",
  id: "rec-1",
  issue_date: "2026-01-15",
};

const invoiceRow = {
  balance: 0,
  code: "INV-0001",
  contract_id: "contract-1",
  discount: 0,
  due_date: "2026-01-15",
  id: "inv-1",
  paid: 1400,
  period_month: 1,
  period_year: 2026,
  subtotal: 1400,
  tenant_id: "tenant-1",
  total: 1400,
} as never;

/** The same row with the relations `buildInvoicePrintHtml` reads. */
const invoiceWithRelations = {
  ...(invoiceRow as object),
  contract: null,
  extraCharges: [],
  properties: [],
  property: null,
  tenant: null,
  unit: null,
  units: [],
} as never;

const baseInput = {
  company: null,
  invoiceFallbackTitle: "Invoice",
  locale: "en" as const,
  payment,
  receipt,
  receiptFallbackTitle: "Receipt",
  tenant: null,
};

describe("settledInvoicesOf", () => {
  test("de-duplicates an invoice settled by two allocations", () => {
    const allocations = [
      { amount: 900, invoice: invoiceRow },
      { amount: 500, invoice: invoiceRow },
    ] as never[];
    expect(settledInvoicesOf(allocations)).toHaveLength(1);
  });

  test("drops allocations that carry no invoice", () => {
    expect(settledInvoicesOf([{ amount: 100, invoice: null }] as never[])).toEqual([]);
  });
});

/**
 * Review round 7 on PR #209. The row gate decides at RENDER time, and an admin
 * can hide a contract after the page rendered — focus refetching is off, so the
 * cached `contractIds` still looks populated and the gate stays open. This is
 * the same rule asked again at click time, where RLS has already withheld the
 * invoices.
 */
describe("hasWithheldAllocations", () => {
  test("is true when the tenant can read the allocations but none of the invoices", () => {
    const allocations = [
      { amount: 300, invoice: null },
      { amount: 200, invoice: null },
    ] as never[];
    expect(hasWithheldAllocations(allocations)).toBe(true);
  });

  /**
   * A payment settling one readable invoice and one hidden one prints the
   * readable half — the per-invoice filtering migration 173 chose deliberately,
   * so that a roof tenant does not lose the paper for their shop invoices.
   */
  test("is false when at least one invoice resolved", () => {
    const allocations = [
      { amount: 300, invoice: null },
      { amount: 200, invoice: invoiceRow },
    ] as never[];
    expect(hasWithheldAllocations(allocations)).toBe(false);
  });

  // An unallocated payment has nothing withheld; its generated receipt is the
  // only paper it has ever had, and it keeps it.
  test("is false for a payment with no allocations at all", () => {
    expect(hasWithheldAllocations([])).toBe(false);
  });
});

describe("buildPaymentDocument", () => {
  test("a payment that settled invoices prints the invoice sheet", () => {
    const document = buildPaymentDocument({
      ...baseInput,
      allocations: [{ amount: 1400, invoice: invoiceRow }] as never[],
      invoices: [invoiceWithRelations],
      breakdowns: new Map([
        [
          "inv-1",
          {
            invoice: {
              code: "INV-0001",
              subtotal: 1400,
              discount: 0,
              total: 1400,
              paid: 1400,
              balance: 0,
              state: "paid",
            },
            paid_from_allocations: 1400,
            reconciled: true,
            groups: [],
          },
        ],
      ]),
    });

    expect(document?.title).toContain("INV-0001");
    expect(document?.title).not.toContain("REC-0009");
    // Filename still carries the receipt code: one payment, one number.
    expect(document?.filename).toContain("REC-0009");
  });

  test("a payment with no allocations prints the receipt", () => {
    const document = buildPaymentDocument({
      ...baseInput,
      allocations: [],
      invoices: [],
      breakdowns: new Map(),
    });

    expect(document?.title).toContain("REC-0009");
    expect(document?.title).not.toContain("INV-0001");
  });

  test("settled invoices that the caller filtered out print nothing at all", () => {
    // The portal's suppression path: the payment settled invoices, but every one
    // belongs to a contract flagged suppress_tenant_billing_docs. Falling back to
    // the receipt here would hand the tenant the billing paper that flag exists
    // to withhold.
    const document = buildPaymentDocument({
      ...baseInput,
      allocations: [{ amount: 1400, invoice: invoiceRow }] as never[],
      invoices: [],
      breakdowns: new Map(),
    });

    expect(document).toBeNull();
  });
});
