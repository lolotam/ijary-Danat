import { describe, expect, it } from "vitest";

import type { Company } from "@/hooks/useCompany";
import type { InvoiceWithRelations } from "@/hooks/useInvoices";
import { buildInvoiceDocument, buildInvoicesDocument } from "@/lib/invoiceDocument";
import type { InvoicePaymentBreakdown } from "@/lib/invoicePaymentBreakdown";

/**
 * The portal's payment row must print the *same paper* the Monthly Invoices
 * section prints — not a document that merely resembles it. These tests pin
 * that equality where it is cheapest to prove: the builder itself.
 */

const company = {
  name_ar: "دانة المستقبل العقارية",
  name_en: "Danat Al Mustaqbal",
  phone: "+965 22334455",
} as unknown as Company;

function invoice(code: string): InvoiceWithRelations {
  return {
    id: code,
    code,
    period_month: 6,
    period_year: 2026,
    issue_date: "2026-06-01",
    due_date: "2026-06-05",
    subtotal: 500,
    discount: 0,
    paid: 500,
    total: 500,
    tenant: { name: "شركة الدانة", name_en: "Danat Co" },
    units: [],
    properties: [],
  } as unknown as InvoiceWithRelations;
}

/**
 * لقطة سداد كاملة لهذه الفاتورة، حتى يكون المستند متعدد الصفحات مطابقًا للمفرد.
 */
function breakdownOf(code: string): InvoicePaymentBreakdown {
  return {
    invoice: {
      code,
      subtotal: 500,
      discount: 0,
      total: 500,
      paid: 500,
      balance: 0,
      state: "paid",
    },
    paid_from_allocations: 500,
    reconciled: true,
    groups: [
      {
        source: "manual",
        method: "cash",
        amount: 500,
        first_paid_on: "2026-06-05",
        last_paid_on: "2026-06-05",
        payments: 1,
      },
    ],
  };
}

function breakdownsFor(codes: string[]): Map<string, InvoicePaymentBreakdown> {
  return new Map(codes.map((code) => [code, breakdownOf(code)]));
}

describe("buildInvoicesDocument", () => {
  it("with one invoice, is byte-identical to the monthly-invoices document", () => {
    // The exact-clone requirement, pinned: same HTML, same tab title, same
    // download filename, same direction. If either builder changes alone,
    // this fails.
    const single = buildInvoicesDocument(
      [invoice("INV-2026-0001")],
      company,
      "ar",
      "فاتورة",
      breakdownsFor(["INV-2026-0001"]),
    );
    const reference = buildInvoiceDocument(
      invoice("INV-2026-0001"),
      company,
      "ar",
      "فاتورة",
      breakdownOf("INV-2026-0001"),
    );
    expect(single).toEqual(reference);
  });

  it("with several invoices, prints one full page per invoice", () => {
    const doc = buildInvoicesDocument(
      [invoice("INV-2026-0001"), invoice("INV-2026-0002")],
      company,
      "ar",
      "فاتورة",
      breakdownsFor(["INV-2026-0001", "INV-2026-0002"]),
    );
    expect(doc.html).toContain("INV-2026-0001");
    expect(doc.html).toContain("INV-2026-0002");
    // One A4 page per settled invoice, not a truncated single page.
    expect(doc.html.match(/class="doc-page"/g)).toHaveLength(2);
    expect(doc.filename).toBe("INV-2026-0001_INV-2026-0002.pdf");
    expect(doc.dir).toBe("rtl");
  });

  it("files the paper under the receipt code when one settled it", () => {
    // A tenant holding REC-… must not receive a file called INV-…: it is the
    // same money under a number that appears nowhere on their receipt.
    const doc = buildInvoicesDocument(
      [invoice("INV-2026-0001"), invoice("INV-2026-0002")],
      company,
      "ar",
      "فاتورة",
      breakdownsFor(["INV-2026-0001", "INV-2026-0002"]),
      "REC-2026-August-15-08-2026-K7QP3XM9ZR2FT8V",
    );
    expect(doc.filename).toBe("REC-2026-August-15-08-2026-K7QP3XM9ZR2FT8V.pdf");
    // The paper is still the invoices; only the file's name comes from the receipt.
    expect(doc.title).toContain("INV-2026-0001");
  });

  it("refuses to build a document from an empty payment", () => {
    // A silent empty paper is worse than a loud error: the caller would hand
    // the tenant a blank download.
    expect(() => buildInvoicesDocument([], company, "ar", "فاتورة", new Map())).toThrow();
  });

  it("throws when a snapshot is missing from the map", () => {
    expect(() =>
      buildInvoicesDocument([invoice("INV-2026-0001")], company, "ar", "فاتورة", new Map()),
    ).toThrow(/Missing payment breakdown/);
  });
});

describe("buildInvoiceDocument", () => {
  it("names the download after the receipt when the invoice is settled", () => {
    const doc = buildInvoiceDocument(
      invoice("INV-0056676"),
      company,
      "ar",
      "فاتورة",
      breakdownOf("INV-0056676"),
      "REC-2026-August-15-08-2026-K7QP3XM9ZR2FT8V",
    );
    expect(doc.filename).toBe("REC-2026-August-15-08-2026-K7QP3XM9ZR2FT8V.pdf");
  });

  it("keeps the invoice code when nothing has settled it", () => {
    expect(
      buildInvoiceDocument(
        invoice("INV-0056676"),
        company,
        "ar",
        "فاتورة",
        breakdownOf("INV-0056676"),
      ).filename,
    ).toBe("INV-0056676.pdf");
  });
});
