import { describe, expect, it } from "vitest";

import type { Company } from "@/hooks/useCompany";
import type { InvoiceWithRelations } from "@/hooks/useInvoices";
import type { InvoicePaymentBreakdown } from "@/lib/invoicePaymentBreakdown";
import { loadInvoiceDocument, loadInvoicesDocument } from "@/lib/invoiceDocumentLoader";

const company = { name_ar: "دانة المستقبل العقارية" } as unknown as Company;

/**
 * فاتورة اختبار بلا علاقات، بما يكفي لبناء المستند.
 */
function invoice(id: string, code: string): InvoiceWithRelations {
  return {
    id,
    code,
    period_month: 1,
    period_year: 2026,
    issue_date: "2026-01-01",
    due_date: "2026-01-05",
    subtotal: 500,
    discount: 0,
    paid: 0,
    total: 500,
    tenant: { name: "شركة الدانة" },
    units: [],
    properties: [],
    extraCharges: [],
  } as unknown as InvoiceWithRelations;
}

/**
 * لقطة غير مسدّدة مطابقة لأرقام الفاتورة.
 */
function unpaidBreakdown(code: string): InvoicePaymentBreakdown {
  return {
    invoice: {
      code,
      subtotal: 500,
      discount: 0,
      total: 500,
      paid: 0,
      balance: 500,
      state: "due",
    },
    paid_from_allocations: 0,
    reconciled: true,
    groups: [],
  };
}

describe("loadInvoiceDocument", () => {
  it("throws on a failed fetch and does not return a document", async () => {
    await expect(
      loadInvoiceDocument({
        invoice: invoice("inv-1", "INV-1"),
        company,
        locale: "en",
        fallbackTitle: "Invoice",
        fetchBreakdown: async () => {
          throw new Error("network");
        },
      }),
    ).rejects.toThrow("network");
  });
});

describe("loadInvoicesDocument", () => {
  it("throws when a map entry is missing and the fetcher cannot supply it", async () => {
    await expect(
      loadInvoicesDocument([invoice("inv-1", "INV-1"), invoice("inv-2", "INV-2")], {
        company,
        locale: "en",
        fallbackTitle: "Invoice",
        breakdowns: new Map([["inv-1", unpaidBreakdown("INV-1")]]),
        fetchBreakdown: async (id) => {
          throw new Error(`missing ${id}`);
        },
      }),
    ).rejects.toThrow("missing inv-2");
  });

  it("builds when every invoice has a snapshot", async () => {
    const doc = await loadInvoicesDocument([invoice("inv-1", "INV-1")], {
      company,
      locale: "en",
      fallbackTitle: "Invoice",
      fetchBreakdown: async () => unpaidBreakdown("INV-1"),
    });
    expect(doc.html).toContain("INV-1");
    expect(doc.html).toContain("Unpaid");
  });
});
