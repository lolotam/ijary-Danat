import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { Company } from "@/hooks/useCompany";
import type { AllocationWithInvoice } from "@/hooks/usePaymentAllocations";
import type { Tables } from "@/integrations/supabase/database.types";
import { buildPaymentReceiptDocument } from "@/lib/paymentDocument";
import { buildPaymentReceiptHtml, type ReceiptIdentity } from "@/lib/paymentReceiptHtml";

/**
 * The payment receipt must have exactly ONE renderer.
 *
 * Before this, the admin panel drew its own JSX receipt while the portal built
 * HTML from `buildPaymentReceiptHtml`. The same payment produced two different
 * documents: the portal's carried the reference, the manual-payment reason and
 * the bank block; the admin's carried the receipt number and was hard-coded to
 * Arabic. Neither carried the invoice's discount.
 *
 * These tests fail if a second renderer reappears, and pin the fields whose
 * absence was the original complaint.
 */

const payment = {
  id: "pay-1",
  code: "PMT-2026-0007",
  amount: 750,
  currency: "KWD",
  method: "knet",
  status: "confirmed",
  payment_date: "2026-07-20",
  reference: "REF-99",
} as unknown as Tables<"payments">;

const company = {
  name_ar: "دانة المستقبل العقارية",
  name_en: "Danat Al Mustaqbal",
  bank_name: "NBK",
  iban: "KW81CBKU0000000000001234560101",
  phone: "+965 22334455",
} as unknown as Company;

const receipt: ReceiptIdentity = { code: "RCP-2026-0031", issue_date: "2026-07-21T00:00:00.000Z" };

function allocation(
  id: string,
  amount: number,
  invoice: Partial<Tables<"invoices">>,
): AllocationWithInvoice {
  return {
    id,
    payment_id: payment.id,
    invoice_id: `inv-${id}`,
    amount,
    invoice: { id: `inv-${id}`, ...invoice } as Tables<"invoices">,
  } as AllocationWithInvoice;
}

const discounted = [
  allocation("a1", 450, {
    code: "INV-2026-0001",
    period_month: 6,
    period_year: 2026,
    subtotal: 500,
    discount: 50,
    total: 450,
  }),
];

const undiscounted = [
  allocation("a2", 500, {
    code: "INV-2026-0002",
    period_month: 7,
    period_year: 2026,
    subtotal: 500,
    discount: 0,
    total: 500,
  }),
];

describe("the receipt carries the invoice detail it was missing", () => {
  it("shows a discount column when any invoice on it was discounted", () => {
    // The original complaint: the tenancy-detail document showed the discount
    // and the portal receipt did not.
    const html = buildPaymentReceiptHtml(payment, discounted, company, "en");
    expect(html).toContain("Discount");
    expect(html).toContain("Invoice total");
    expect(html).toContain("50 KWD");
  });

  it("shows it in Arabic too", () => {
    const html = buildPaymentReceiptHtml(payment, discounted, company, "ar");
    expect(html).toContain("الخصم");
    expect(html).toContain("إجمالي الفاتورة");
  });

  it("omits the column entirely when nothing on the receipt is discounted", () => {
    // A column of dashes on every ordinary receipt would be worse than the
    // omission it replaces.
    const html = buildPaymentReceiptHtml(payment, undiscounted, company, "en");
    expect(html).not.toContain("Invoice total");
  });

  it("prints the receipt's own identity, not only the payment's", () => {
    // A payment code and a payment date are not interchangeable with the
    // issued receipt's number and issue date — that is what a tenant quotes,
    // and it heads the document exactly where the invoice's code does.
    const html = buildPaymentReceiptHtml(payment, discounted, company, "en", { receipt });
    expect(html).toContain('<p class="code">RCP-2026-0031</p>');
    expect(html).toContain("2026-07-21");
    expect(html).toContain("Issue date");
  });

  it("falls back to the payment code when the tenant may not see the receipt row", () => {
    // RLS hides receipts that are not `visible_to_tenant`, and the document
    // still has to be headed with something.
    const html = buildPaymentReceiptHtml(payment, discounted, company, "en");
    expect(html).toContain('<p class="code">PMT-2026-0007</p>');
    expect(html).not.toContain("RCP-2026-0031");
  });

  it("files the document under the receipt code when there is one", () => {
    const withReceipt = buildPaymentReceiptDocument(
      payment,
      discounted,
      company,
      "en",
      "Receipt",
      null,
      receipt,
    );
    expect(withReceipt.filename).toBe("RCP-2026-0031.pdf");
    expect(withReceipt.title).toContain("RCP-2026-0031");

    const withoutReceipt = buildPaymentReceiptDocument(
      payment,
      discounted,
      company,
      "en",
      "Receipt",
    );
    expect(withoutReceipt.filename).toBe("PMT-2026-0007.pdf");
  });
});

describe("numbers that must read left-to-right in an Arabic document", () => {
  it("isolates the company phone in the footer", () => {
    // Without isolation the bidi algorithm moves "+965" to the wrong end.
    const html = buildPaymentReceiptHtml(payment, discounted, company, "ar");
    expect(html).toMatch(/<bdi dir="ltr">\+965 22334455<\/bdi>/);
  });

  it("isolates the IBAN", () => {
    const html = buildPaymentReceiptHtml(payment, discounted, company, "ar");
    expect(html).toMatch(/<bdi dir="ltr">KW81CBKU0000000000001234560101<\/bdi>/);
  });

  it("puts dir on the isolating element only, never on the row that holds it", () => {
    // `text-align: start` resolves against an element's OWN direction, so an
    // outer dir="ltr" would slide the value to the wrong edge of an Arabic
    // page — the exact misalignment the isolation is meant to prevent.
    const html = buildPaymentReceiptHtml(payment, discounted, company, "ar");
    expect(html).not.toMatch(/<span class="value" dir="ltr"/);
    expect(html).not.toMatch(/<div class="doc-row" dir=/);
  });

  it("isolates the phone on the printed invoice as well", async () => {
    const { buildInvoicePrintHtml } = await import("@/lib/invoicePrintHtml");
    const invoice = {
      code: "INV-2026-0001",
      period_month: 6,
      period_year: 2026,
      issue_date: "2026-06-01",
      due_date: "2026-06-05",
      subtotal: 500,
      discount: 50,
      paid: 0,
      total: 450,
      tenant: { name: "شركة الدانة", name_en: "Danat Co" },
      units: [],
      properties: [],
    } as never;
    const html = buildInvoicePrintHtml(invoice, company, "ar", {
      invoice: {
        code: "INV-2026-0001",
        subtotal: 500,
        discount: 50,
        total: 450,
        paid: 0,
        balance: 450,
        state: "due",
      },
      paid_from_allocations: 0,
      reconciled: true,
      groups: [],
    });
    expect(html).toMatch(/<bdi dir="ltr">\+965 22334455<\/bdi>/);
  });
});

/**
 * Reported 2026-08-30: a payment settling a 750 rent plus a 20 cleaning charge
 * printed a single 770 on the receipt, with nothing naming the 20. The charge
 * was already its own `invoice_items` row flagged `is_extra_charge` (migration
 * 169) — no document read the flag.
 */
describe("the receipt names the service charges it settled", () => {
  const cleaning = [{ amount: 20, description_ar: "النظافة", description_en: "Cleaning" }];
  const withCharges = [
    {
      ...allocation("a3", 770, {
        code: "INV-2026-0003",
        period_month: 8,
        period_year: 2026,
        subtotal: 770,
        discount: 0,
        total: 770,
      }),
      extraCharges: cleaning,
    },
  ];

  it("shows the charge and its category", () => {
    const html = buildPaymentReceiptHtml(payment, withCharges, company, "en");
    expect(html).toContain("Extra expense");
    expect(html).toContain("(Cleaning)");
  });

  it("shows it in Arabic too", () => {
    const html = buildPaymentReceiptHtml(payment, withCharges, company, "ar");
    expect(html).toContain("مصروفات إضافية");
    expect(html).toContain("(النظافة)");
  });

  it("omits the column entirely when nothing on the receipt carries a charge", () => {
    // Same rule as the discount column, and the same reason: a column of zeroes
    // on every ordinary receipt would be worse than the omission it replaces.
    expect(buildPaymentReceiptHtml(payment, undiscounted, company, "en")).not.toContain(
      "Extra expense",
    );
  });

  /**
   * The header and the total row's colspan are now derived from two independent
   * flags. Get the arithmetic wrong and the total slides under the wrong
   * heading — a receipt that reads as if the payment were the discount. Each
   * combination is counted, because only the both-on case would catch a formula
   * that happens to be right for one flag at a time.
   *
   * `discounted` and `undiscounted` carry no `extraCharges` at all, which is
   * also the shape the server path degrades to when its lookup fails and the
   * shape of every allocation built before the field existed.
   */
  it.each([
    ["neither", undiscounted, 4],
    ["a discount alone", discounted, 6],
    ["a charge alone", withCharges, 5],
    ["both", [{ ...withCharges[0], invoice: { ...withCharges[0].invoice!, discount: 50 } }], 7],
  ])("counts the columns right with %s", (_label, allocations, columns) => {
    const html = buildPaymentReceiptHtml(payment, allocations, company, "en");
    expect((html.match(/<th[\s>]/g) ?? []).length).toBe(columns);
    expect(html).toContain(`<td colspan="${columns - 1}">`);
  });
});

describe("there is only one payment-document renderer", () => {
  // Comments stripped: the negative assertions must judge the shipped code,
  // not the prose that documents what it no longer does. The doc comment names
  // `dir="rtl"` precisely because that is what was removed.
  const paymentPrintSource = readFileSync(
    resolve(process.cwd(), "src/components/admin/PaymentDocumentPrint.tsx"),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  it("the admin sheet picks its document through the shared selector", () => {
    // Not `buildPaymentReceiptDocument` directly: calling the receipt builder
    // unconditionally is exactly the defect this file now guards. The portal
    // prints the invoice sheet when the payment settled invoices, and the admin
    // has to make that same choice from the same place.
    expect(paymentPrintSource).toContain("buildPaymentDocument");
    expect(paymentPrintSource).not.toContain("buildPaymentReceiptDocument");
  });

  it("the admin sheet declares no table, allocation loop or money formatter", () => {
    // Each of these is how the second implementation grew the first time.
    // `[\s>]` so the TypeScript generic `Pick<Tables<"payments">>` is not read
    // as a `<table` element.
    expect(paymentPrintSource).not.toMatch(/<table[\s>]/i);
    expect(paymentPrintSource).not.toMatch(/allocations\.map/);
    expect(paymentPrintSource).not.toMatch(/Intl\.NumberFormat/);
    expect(paymentPrintSource).not.toMatch(/formatKwd|formatAmount/);
  });

  it("the admin sheet is not hard-coded to one language", () => {
    expect(paymentPrintSource).not.toMatch(/dir="rtl"/);
    expect(paymentPrintSource).toContain("locale");
  });

  it("built HTML reaches the admin DOM only through a sandboxed iframe", () => {
    // Same house rule as MessagePreviewPanel and GeneratedReportPreviewDialog.
    expect(paymentPrintSource).toContain("srcDoc");
    expect(paymentPrintSource).toContain('sandbox=""');
    expect(paymentPrintSource).not.toMatch(/dangerouslySetInnerHTML\s*=/);
  });
});

describe("the receipt and the invoice are the same paper", () => {
  /**
   * The complaint this block exists for: the portal's receipt and the printed
   * invoice looked like documents from two different companies. The receipt had
   * a filled dark-green table head, a grey rounded total pill floated to one
   * side and a status badge; the invoice had hairline rules and a green-
   * underlined total row. Both now compose `printedDocument.ts`.
   */
  const invoice = {
    code: "INV-2026-0001",
    period_month: 6,
    period_year: 2026,
    issue_date: "2026-06-01",
    due_date: "2026-06-05",
    subtotal: 500,
    discount: 50,
    paid: 0,
    total: 450,
    tenant: { name: "شركة الدانة", name_en: "Danat Co" },
    units: [],
    properties: [],
  } as never;

  async function bothDocuments() {
    const { buildInvoicePrintHtml } = await import("@/lib/invoicePrintHtml");
    return {
      invoiceHtml: buildInvoicePrintHtml(invoice, company, "ar", {
        invoice: {
          code: "INV-2026-0001",
          subtotal: 500,
          discount: 50,
          total: 450,
          paid: 0,
          balance: 450,
          state: "due",
        },
        paid_from_allocations: 0,
        reconciled: true,
        groups: [],
      }),
      receiptHtml: buildPaymentReceiptHtml(payment, discounted, company, "ar", { receipt }),
    };
  }

  it("renders both through one stylesheet, byte for byte", async () => {
    const { PRINTED_DOCUMENT_CSS } = await import("@/lib/printedDocument");
    const { invoiceHtml, receiptHtml } = await bothDocuments();
    expect(invoiceHtml).toContain(PRINTED_DOCUMENT_CSS);
    expect(receiptHtml).toContain(PRINTED_DOCUMENT_CSS);
  });

  it("uses the same page, header, grid and footer elements", async () => {
    const { invoiceHtml, receiptHtml } = await bothDocuments();
    for (const marker of [
      'class="doc-page"',
      'class="doc-header"',
      'class="doc-grid"',
      'class="doc-amounts"',
      'class="doc-footer"',
    ]) {
      expect(invoiceHtml).toContain(marker);
      expect(receiptHtml).toContain(marker);
    }
  });

  it("heads both with the code above the document title", async () => {
    const { invoiceHtml, receiptHtml } = await bothDocuments();
    for (const html of [invoiceHtml, receiptHtml]) {
      expect(html.indexOf('<p class="code">')).toBeLessThan(html.indexOf("<h1>"));
    }
  });

  it("closes both with a total row inside the amounts table", async () => {
    // Not a floated box beside it: that was the single most visible difference
    // between the two documents.
    const { invoiceHtml, receiptHtml } = await bothDocuments();
    expect(invoiceHtml).toContain('<tr class="total">');
    expect(receiptHtml).toContain('<tr class="total">');
  });

  it("leaves the receipt no styling of its own", async () => {
    const source = readFileSync(resolve(process.cwd(), "src/lib/paymentReceiptHtml.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // A second stylesheet is exactly how the two drifted apart the first time.
    expect(source).not.toMatch(/background:\s*#/);
    expect(source).not.toMatch(/border-radius/);
    expect(source).not.toMatch(/font-size:\s*\d/);
  });
});

describe("every surface prints the same receipt number", () => {
  /**
   * A receipt has one number. The admin dialog loaded the `receipts` row and
   * headed the document with its code while the portal and the emailed PDF fell
   * back to the payment code, so a tenant asking the office about "receipt
   * PAY-27" matched nothing on file.
   *
   * Source-level assertions because the surfaces are a React component and a
   * server function whose real dependencies are Supabase and Chromium; the
   * number itself is pinned by the rendering tests above and by
   * `paymentReceiptPdf.test.ts`.
   */
  function sourceOf(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
  }

  it("the portal row actions load the receipt, not only the allocations", () => {
    const source = sourceOf("src/components/portal/PaymentRowActions.tsx");
    expect(source).toContain("fetchReceipts");
  });

  it("the emailed PDF looks the receipt up too", () => {
    const source = sourceOf("src/lib/paymentReceiptPdf.ts");
    expect(source).toMatch(/from\("receipts"\)/);
  });
});

describe("the emailed document is the platform's document", () => {
  /**
   * Reported 2026-09-08. Three surfaces agreed and a fourth did not: the admin
   * payments dialog and the portal payment row both asked
   * `buildPaymentDocument` which paper to print, while the PDF attached to the
   * payment mail called the receipt renderer unconditionally. So a payment that
   * settled an invoice reached the tenant as an invoice sheet on screen and a
   * payment-receipt sheet in their inbox.
   *
   * The three surfaces are now three callers of one selector, and these
   * assertions are what stops the fourth from growing its own choice again.
   * Source-level because this module's real dependencies are Supabase and
   * Chromium; the documents themselves are pinned in `paymentReceiptPdf.test.ts`.
   */
  function sourceOf(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
  }

  const server = sourceOf("src/lib/paymentReceiptPdf.ts");

  it("asks the shared selector which paper to print", () => {
    expect(server).toContain("buildPaymentDocument");
  });

  it("calls neither builder directly", () => {
    // Either one called from here IS the second implementation: the receipt
    // builder was the original defect, and reaching past the selector to the
    // invoice builder would re-create it facing the other way.
    expect(server).not.toContain("buildPaymentReceiptHtml");
    expect(server).not.toContain("buildPaymentReceiptDocument");
    expect(server).not.toContain("buildInvoicesDocument");
    expect(server).not.toContain("buildInvoicePrintHtml");
  });

  it("declares no markup, table or money formatter of its own", () => {
    expect(server).not.toMatch(/<table[\s>]/i);
    expect(server).not.toMatch(/<article[\s>]/i);
    expect(server).not.toMatch(/formatKwd|Intl\.NumberFormat/);
  });

  it("loads the invoice relations through the one client-agnostic loader", () => {
    // The reason the mail forked in the first place: the invoice sheet needs
    // these rows and the only loader for them was bound to the browser client.
    expect(server).toContain("loadInvoicesWithRelations");
    expect(server).toContain("parseInvoicePaymentBreakdown");
  });

  it("keeps that loader free of the browser client", () => {
    // `invoiceRelations` is imported by a server module now, so a runtime
    // import of the browser client there would drag it into the server bundle —
    // the same failure mode as the `usePaymentAllocations` import this file's
    // sibling suite pins.
    const relations = sourceOf("src/lib/invoiceRelations.ts");
    expect(relations).not.toContain("@/integrations/supabase/client");
    expect(relations).not.toContain("@/hooks/");
  });
});

describe("there is only one invoice renderer", () => {
  /**
   * The admin invoice sheet used to draw its own JSX table beside the built
   * document, so the two disagreed the moment either changed — the service
   * charges row would have reached the printed paper and not the preview the
   * operator checks it against. Same failure `ReceiptPrint` was fixed for, and
   * pinned the same way.
   */
  const invoicePrintSource = readFileSync(
    resolve(process.cwd(), "src/components/admin/InvoicePrint.tsx"),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  it("renders the shared document, not its own markup", () => {
    expect(invoicePrintSource).toContain("buildInvoiceDocument");
  });

  it("declares no table, detail row or money formatter of its own", () => {
    expect(invoicePrintSource).not.toMatch(/<table[\s>]/i);
    expect(invoicePrintSource).not.toMatch(/formatKwd|Intl\.NumberFormat/);
    expect(invoicePrintSource).not.toMatch(/<td[\s>]/i);
  });

  it("puts the built HTML behind a sandboxed iframe", () => {
    expect(invoicePrintSource).toContain("srcDoc");
    expect(invoicePrintSource).toContain('sandbox=""');
    expect(invoicePrintSource).not.toMatch(/dangerouslySetInnerHTML\s*=/);
  });
});

describe("the portal payment row prints the invoice's own paper", () => {
  /**
   * The recurring tenant complaint: the document downloaded from a portal
   * payment row looked nothing like the invoice downloaded from Monthly
   * Invoices — different code, different title, different fields. The row now
   * renders the settled invoices through the shared invoice builder, and the
   * payment-receipt document remains only as the no-allocation fallback.
   */
  function sourceOf(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
  }

  it("builds the invoice document through the shared builder", () => {
    const source = sourceOf("src/components/portal/PaymentRowActions.tsx");
    expect(source).toContain("buildPaymentDocument");
    expect(source).toContain("fetchInvoicesWithRelations");
  });

  it("makes the invoice-or-receipt choice in one place, not two", () => {
    // Neither builder is called from a component any more. Both the portal row
    // and the admin dialog delegate to `buildPaymentDocument`, which is the only
    // reason they cannot disagree: calling `buildPaymentReceiptDocument`
    // directly from a component is exactly how the admin copy drifted into
    // printing a receipt for a payment the portal printed as an invoice.
    for (const path of [
      "src/components/portal/PaymentRowActions.tsx",
      "src/components/admin/PaymentDocumentPrint.tsx",
    ]) {
      const source = sourceOf(path);
      expect(source, path).toContain("buildPaymentDocument");
      expect(source, path).not.toContain("buildPaymentReceiptDocument");
      expect(source, path).not.toContain("buildInvoicesDocument");
    }
  });
});
