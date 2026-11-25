import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Tables } from "@/integrations/supabase/database.types";
import { ID_CHUNK_SIZE } from "@/lib/idChunks";
import { PRINTED_DOCUMENT_CSS } from "@/lib/printedDocument";

const allocationsIn = vi.fn();
const invoicesIn = vi.fn();
const receiptsIn = vi.fn();
const invoiceItemsIn = vi.fn();
const companyRow = vi.fn();
const tenantRow = vi.fn();
const relationIn = vi.fn();
const breakdownRpc = vi.fn();
const upload = vi.fn();
const list = vi.fn();
const renderHtmlToPdf = vi.fn();

/**
 * Mocked at the real boundaries only — Postgres, Storage, and the Chromium
 * child process. `renderAndStorePdf` and `buildPaymentReceiptHtml` run for
 * real, so these tests prove what actually reaches the renderer and the bucket
 * rather than what a stubbed helper was asked for.
 */
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "payment_allocations") {
        return { select: () => ({ in: () => ({ order: () => ({ order: allocationsIn }) }) }) };
      }
      if (table === "invoices") {
        return { select: () => ({ in: invoicesIn }) };
      }
      if (table === "invoice_items") {
        return { select: () => ({ in: invoiceItemsIn }) };
      }
      if (table === "receipts") {
        return { select: () => ({ in: receiptsIn }) };
      }
      if (table === "tenants") {
        // The party lookup reads one row by id; the invoice-sheet enrichment
        // reads many by `in()`. Both hang off the same table.
        return { select: () => ({ eq: () => ({ maybeSingle: tenantRow }), in: relationIn }) };
      }
      if (table === "units" || table === "properties" || table === "contracts") {
        return { select: () => ({ in: relationIn }) };
      }
      return { select: () => ({ order: () => ({ limit: () => ({ maybeSingle: companyRow }) }) }) };
    },
    rpc: (name: string, args: Record<string, unknown>) => breakdownRpc(name, args),
    storage: { from: () => ({ list, upload }) },
  },
}));

vi.mock("@/lib/serverPdf", async () => {
  // wrapHtmlForPdf is pure and covered by serverPdf.test.ts; the real one keeps
  // this honest about the document Chromium is actually handed.
  const actual = await vi.importActual<typeof import("./serverPdf")>("./serverPdf");
  return {
    renderHtmlToPdf: (html: string) => renderHtmlToPdf(html),
    wrapHtmlForPdf: actual.wrapHtmlForPdf,
  };
});

const { renderPaymentReceiptPdfs } = await import("./paymentReceiptPdf");

const PAYMENT_A = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  tenant_id: "tenant-1",
  code: "PAY-1",
  amount: 250,
  currency: "KWD",
  method: "bank_transfer",
  payment_date: "2026-08-01",
  reference: "REF-1",
  status: "confirmed",
} as unknown as Tables<"payments">;

const PAYMENT_B = {
  ...PAYMENT_A,
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  code: "PAY-2",
  reference: "REF-2",
};

/** The HTML handed to Chromium for each payment, in call order. */
function renderedDocuments(): string[] {
  return renderHtmlToPdf.mock.calls.map(([html]) => html as string);
}

/** The storage keys written, in call order. */
function uploadedPaths(): string[] {
  return upload.mock.calls.map(([path]) => path as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  allocationsIn.mockResolvedValue({ data: [], error: null });
  invoicesIn.mockResolvedValue({ data: [], error: null });
  invoiceItemsIn.mockResolvedValue({ data: [], error: null });
  receiptsIn.mockResolvedValue({ data: [], error: null });
  relationIn.mockResolvedValue({ data: [], error: null });
  // The snapshot the invoice sheet prints its payments section from. Shaped
  // like the RPC's jsonb, because `parseInvoicePaymentBreakdown` runs for real.
  breakdownRpc.mockImplementation(async (_name: string, args: Record<string, unknown>) => ({
    data: {
      invoice: {
        code: String(args.p_invoice_id),
        subtotal: 770,
        discount: 0,
        total: 770,
        paid: 770,
        balance: 0,
        state: "paid",
      },
      paid_from_allocations: 770,
      reconciled: true,
      groups: [],
    },
    error: null,
  }));
  companyRow.mockResolvedValue({ data: null, error: null });
  tenantRow.mockResolvedValue({
    data: { commercial_name: "Danat Cafe", name: "شركة x", name_en: "Company X" },
    error: null,
  });
  renderHtmlToPdf.mockResolvedValue(Buffer.from("%PDF-1.4"));
  upload.mockResolvedValue({ data: { path: "x" }, error: null });
  // Nothing stored yet, so each test renders unless it stages a hit itself.
  list.mockResolvedValue({ data: [], error: null });
});

describe("renderPaymentReceiptPdfs", () => {
  it("stores one document per payment under the receipts prefix", async () => {
    // A multi-month payment link confirms one payment per invoice month, and
    // each is its own receipt. Collapsing them would send a tenant a document
    // for a fraction of what they paid.
    const stored = await renderPaymentReceiptPdfs({
      locale: "en",
      manualPaymentReason: null,
      payments: [PAYMENT_A, PAYMENT_B],
    });

    expect(stored).toHaveLength(2);
    expect(uploadedPaths()).toEqual([
      expect.stringMatching(
        new RegExp(`^payment-receipts/PAY-1-${PAYMENT_A.id}-[0-9a-f]{12}\\.pdf$`),
      ),
      expect.stringMatching(
        new RegExp(`^payment-receipts/PAY-2-${PAYMENT_B.id}-[0-9a-f]{12}\\.pdf$`),
      ),
    ]);
    expect(stored.map((document) => document.bucket)).toEqual([
      "report-documents",
      "report-documents",
    ]);
  });

  it("heads the emailed receipt with the issued receipt number", async () => {
    // The office copy, the portal download and the emailed attachment are one
    // document, so they must be one number. Before this the email and the
    // portal quoted the payment code while the admin quoted the receipt code,
    // and a tenant asking about "receipt PAY-27" matched nothing on file.
    receiptsIn.mockResolvedValue({
      data: [
        {
          code: "REC-2026-August-15-08-2026-B65EC44D58163RD",
          issue_date: "2026-08-15",
          payment_id: PAYMENT_A.id,
        },
      ],
      error: null,
    });

    await renderPaymentReceiptPdfs({
      locale: "en",
      manualPaymentReason: null,
      payments: [PAYMENT_A],
    });

    expect(renderedDocuments()[0]).toContain("REC-2026-August-15-08-2026-B65EC44D58163RD");
    expect(uploadedPaths()[0]).toContain("REC-2026-August-15-08-2026-B65EC44D58163RD");
  });

  it("falls back to the payment code before the receipt row exists", async () => {
    await renderPaymentReceiptPdfs({
      locale: "en",
      manualPaymentReason: null,
      payments: [PAYMENT_A],
    });

    expect(renderedDocuments()[0]).toContain("PAY-1");
  });

  it("keys each object on the payment id, never on the code", async () => {
    // Two payments could share a code after a data correction; ids cannot
    // collide, and a colliding key would email one payment's receipt for
    // another's.
    await renderPaymentReceiptPdfs({
      locale: "en",
      manualPaymentReason: null,
      payments: [PAYMENT_A],
    });

    expect(uploadedPaths()[0]).toContain(PAYMENT_A.id);
  });

  // Task: a receipt already in the bucket must not be printed a second time.
  // Re-notifying a payment re-entered this path and spent a Chromium run
  // reproducing bytes that were already stored.
  it("reuses the stored receipt instead of rendering it again", async () => {
    const [first] = await renderPaymentReceiptPdfs({
      locale: "en",
      manualPaymentReason: null,
      payments: [PAYMENT_A],
    });
    vi.clearAllMocks();
    list.mockResolvedValue({
      data: [{ name: first.path.slice(first.path.lastIndexOf("/") + 1) }],
      error: null,
    });

    const [second] = await renderPaymentReceiptPdfs({
      locale: "en",
      manualPaymentReason: null,
      payments: [PAYMENT_A],
    });

    expect(second).toEqual(first);
    expect(renderHtmlToPdf).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  // The reuse must not outlive the content it was keyed on: a receipt stored
  // before a manual reason was recorded would otherwise be attached forever.
  it("renders a fresh receipt once a manual payment reason is added", async () => {
    const [withoutReason] = await renderPaymentReceiptPdfs({
      locale: "en",
      manualPaymentReason: null,
      payments: [PAYMENT_A],
    });
    list.mockResolvedValue({
      data: [{ name: withoutReason.path.slice(withoutReason.path.lastIndexOf("/") + 1) }],
      error: null,
    });
    renderHtmlToPdf.mockClear();

    const [withReason] = await renderPaymentReceiptPdfs({
      locale: "en",
      manualPaymentReason: "Bank transfer",
      payments: [PAYMENT_A],
    });

    expect(withReason.path).not.toEqual(withoutReason.path);
    expect(renderHtmlToPdf).toHaveBeenCalledTimes(1);
    expect(renderedDocuments()[0]).toContain("Reason of manual payment");
  });

  it("prints the manual payment reason beside the method on a hand-settled receipt", async () => {
    await renderPaymentReceiptPdfs({
      locale: "en",
      manualPaymentReason: "Bank transfer",
      payments: [PAYMENT_A],
    });

    // The pair is the point: the method says how the money arrived, the reason
    // says why it was recorded by hand.
    expect(renderedDocuments()[0]).toContain("Payment method");
    expect(renderedDocuments()[0]).toContain("Reason of manual payment");
    expect(renderedDocuments()[0]).toContain("Bank transfer");
  });

  it("leaves a gateway receipt free of the reason row", async () => {
    // A card payer has no manual reason, and a row inviting them to ask what
    // went wrong when nothing did is worse than no row.
    await renderPaymentReceiptPdfs({
      locale: "en",
      manualPaymentReason: null,
      payments: [PAYMENT_A],
    });

    expect(renderedDocuments()[0]).not.toContain("Reason of manual payment");
  });

  it("prints the commercial name as the party, not the legal tenant name", async () => {
    await renderPaymentReceiptPdfs({
      locale: "en",
      manualPaymentReason: null,
      payments: [PAYMENT_A],
    });

    expect(renderedDocuments()[0]).toContain("Danat Cafe");
    expect(renderedDocuments()[0]).not.toContain("Company X");
  });

  it("hands Chromium an RTL document for an Arabic tenant", async () => {
    await renderPaymentReceiptPdfs({
      locale: "ar",
      manualPaymentReason: "تحويل بنكي",
      payments: [PAYMENT_A],
    });

    expect(renderedDocuments()[0]).toContain('dir="rtl"');
    expect(renderedDocuments()[0]).toContain("سبب الدفع اليدوي");
  });

  it("gives each receipt only its own payment's invoices", async () => {
    // The allocations arrive interleaved from a single query; grouping is what
    // stops one tenant's receipt from listing another payment's invoices.
    allocationsIn.mockResolvedValue({
      data: [
        { id: "1", payment_id: PAYMENT_A.id, invoice_id: "inv-a", amount: 100 },
        { id: "2", payment_id: PAYMENT_B.id, invoice_id: "inv-b", amount: 150 },
      ],
      error: null,
    });
    invoicesIn.mockResolvedValue({
      data: [
        { id: "inv-a", code: "INV-A", period_month: 1, period_year: 2026, due_date: "2026-01-01" },
        { id: "inv-b", code: "INV-B", period_month: 2, period_year: 2026, due_date: "2026-02-01" },
      ],
      error: null,
    });

    await renderPaymentReceiptPdfs({
      locale: "en",
      manualPaymentReason: null,
      payments: [PAYMENT_A, PAYMENT_B],
    });

    const [first, second] = renderedDocuments();
    expect(first).toContain("INV-A");
    expect(first).not.toContain("INV-B");
    expect(second).toContain("INV-B");
    expect(second).not.toContain("INV-A");
  });

  it("prints the settled invoice's service charge and names its category", async () => {
    // The reported gap: a 750 rent plus a 20 cleaning charge reached the tenant
    // as a single 770 with nothing saying what the 20 was for.
    allocationsIn.mockResolvedValue({
      data: [{ id: "1", payment_id: PAYMENT_A.id, invoice_id: "inv-a", amount: 770 }],
      error: null,
    });
    invoicesIn.mockResolvedValue({
      data: [
        { id: "inv-a", code: "INV-A", period_month: 1, period_year: 2026, due_date: "2026-01-01" },
      ],
      error: null,
    });
    invoiceItemsIn.mockResolvedValue({
      data: [
        {
          invoice_id: "inv-a",
          line: 1,
          amount: 750,
          is_extra_charge: false,
          description_ar: "إيجار",
          description_en: "Rent",
        },
        {
          invoice_id: "inv-a",
          line: 2,
          amount: 20,
          is_extra_charge: true,
          description_ar: "النظافة",
          description_en: "Cleaning",
        },
      ],
      error: null,
    });

    await renderPaymentReceiptPdfs({
      locale: "en",
      manualPaymentReason: null,
      payments: [PAYMENT_A],
    });

    const document = renderedDocuments()[0];
    expect(document).toContain("Extra expense");
    expect(document).toContain("(Cleaning)");
    // The rent line shares the table and must not be counted as a charge.
    expect(document).not.toContain("(Rent)");
  });

  it("splits the service-charge lookup so a large settlement is not clipped", async () => {
    // PR #168 review (Codex, P1). A bare `in()` over every settled invoice hits
    // two silent ceilings: the gateway's 8 KB request line, and PGRST_MAX_ROWS,
    // which returns the first thousand rows with no error and no flag. 200
    // invoices carry up to 2,800 line items here, so the row cap is reachable
    // on a multi-month settlement — and a dropped line reads as a charge that
    // was never billed, understating what the emailed receipt says was paid.
    // The split itself is fetchInChunks' own tested behaviour; what this pins
    // is that this path goes through it at all.
    const invoiceIds = Array.from({ length: 250 }, (_, index) => `inv-${index}`);
    allocationsIn.mockResolvedValue({
      data: invoiceIds.map((invoiceId, index) => ({
        id: `alloc-${index}`,
        payment_id: PAYMENT_A.id,
        invoice_id: invoiceId,
        amount: 10,
      })),
      error: null,
    });

    await renderPaymentReceiptPdfs({
      locale: "en",
      manualPaymentReason: null,
      payments: [PAYMENT_A],
    });

    const chunkSizes = invoiceItemsIn.mock.calls.map(([, ids]) => (ids as string[]).length);
    expect(chunkSizes).toEqual([ID_CHUNK_SIZE, 50]);
  });

  it("still mails the invoice sheet when the service-charge lookup fails", async () => {
    // Same contract as the other queries on this path: the money has already
    // moved, so a lost cell is a degradation and never an outage. The paper is
    // still the platform's invoice sheet — degrading to a DIFFERENT document is
    // the defect this whole path was unified to remove.
    allocationsIn.mockResolvedValue({
      data: [{ id: "1", payment_id: PAYMENT_A.id, invoice_id: "inv-a", amount: 770 }],
      error: null,
    });
    invoicesIn.mockResolvedValue({
      data: [
        { id: "inv-a", code: "INV-A", period_month: 1, period_year: 2026, due_date: "2026-01-01" },
      ],
      error: null,
    });
    invoiceItemsIn.mockResolvedValue({ data: null, error: new Error("items boom") });

    const stored = await renderPaymentReceiptPdfs({
      locale: "en",
      manualPaymentReason: null,
      payments: [PAYMENT_A],
    });

    expect(stored).toHaveLength(1);
    // The sheet, its total and its payments section survive; only the cells the
    // line items feed — the unit and the named charge categories — do not.
    expect(renderedDocuments()[0]).toContain("INV-A");
    expect(renderedDocuments()[0]).toContain('class="doc-amounts"');
    expect(renderedDocuments()[0]).not.toContain("(Cleaning)");
  });

  it("drops a payment whose render failed and still returns the rest", async () => {
    // Losing an attachment is a degradation; losing the receipt is an outage.
    // The caller must still be able to send the mail for the survivors.
    renderHtmlToPdf.mockImplementation(async (html: string) =>
      html.includes("PAY-1")
        ? Promise.reject(new Error("Chromium not found"))
        : Buffer.from("%PDF"),
    );

    const stored = await renderPaymentReceiptPdfs({
      locale: "en",
      manualPaymentReason: null,
      payments: [PAYMENT_A, PAYMENT_B],
    });

    expect(stored).toHaveLength(1);
    expect(stored[0].path).toContain("PAY-2");
  });

  it("renders nothing and touches no table when there are no payments", async () => {
    const stored = await renderPaymentReceiptPdfs({
      locale: "en",
      manualPaymentReason: null,
      payments: [],
    });

    expect(stored).toEqual([]);
    expect(renderHtmlToPdf).not.toHaveBeenCalled();
    expect(allocationsIn).not.toHaveBeenCalled();
  });

  /**
   * Reported 2026-09-08: the PDF attached to the payment mail was a different
   * document from the one every screen prints — the platform showed the
   * settled INVOICE sheet while the mail carried a payment-receipt sheet of its
   * own. Both branches are pinned, because the fix is not "always print the
   * invoice": it is that this path makes the SAME choice the two screens make,
   * through the same selector.
   */
  it("mails the settled invoice sheet, the paper the platform prints", async () => {
    allocationsIn.mockResolvedValue({
      data: [{ id: "1", payment_id: PAYMENT_A.id, invoice_id: "inv-a", amount: 770 }],
      error: null,
    });
    invoicesIn.mockResolvedValue({
      data: [
        { id: "inv-a", code: "INV-A", period_month: 1, period_year: 2026, due_date: "2026-01-01" },
      ],
      error: null,
    });

    await renderPaymentReceiptPdfs({
      locale: "en",
      manualPaymentReason: null,
      payments: [PAYMENT_A],
    });

    const document = renderedDocuments()[0];
    // The invoice sheet's own rows, and the payments section that only the
    // breakdown snapshot can fill — the field the emailed document never had.
    expect(document).toContain("Invoice total");
    expect(document).toContain("Remaining");
    expect(document).not.toContain("Payment receipt");
    // And the reported complaint itself, asserted on the bytes Chromium is
    // handed rather than on the builder: the emailed paper carries the one
    // printed-document stylesheet, so it cannot look like a different company's
    // document again. `receiptConsistency.test.ts` pins that the invoice and
    // the receipt share it; this pins that the MAIL is inside that guarantee.
    expect(document).toContain(PRINTED_DOCUMENT_CSS);
  });

  it("mails the payment-receipt sheet when the payment settled no invoice", async () => {
    // The only case the two screens print a receipt for, and therefore the only
    // case this path may.
    await renderPaymentReceiptPdfs({
      locale: "en",
      manualPaymentReason: null,
      payments: [PAYMENT_A],
    });

    expect(renderedDocuments()[0]).toContain("Payment receipt");
  });

  it("refuses an attachment rather than mail a document with no payments section", async () => {
    // The snapshot is what the invoice sheet prints its paid/remaining rows
    // from, and there is no honest stand-in. Falling back to the receipt sheet
    // is what put two designs in front of one tenant to begin with, so this
    // path sends the mail as HTML instead.
    allocationsIn.mockResolvedValue({
      data: [{ id: "1", payment_id: PAYMENT_A.id, invoice_id: "inv-a", amount: 770 }],
      error: null,
    });
    invoicesIn.mockResolvedValue({
      data: [
        { id: "inv-a", code: "INV-A", period_month: 1, period_year: 2026, due_date: "2026-01-01" },
      ],
      error: null,
    });
    breakdownRpc.mockResolvedValue({ data: null, error: { message: "rpc boom" } });

    const stored = await renderPaymentReceiptPdfs({
      locale: "en",
      manualPaymentReason: null,
      payments: [PAYMENT_A],
    });

    expect(stored).toEqual([]);
    expect(renderHtmlToPdf).not.toHaveBeenCalled();
  });

  it("still produces a receipt when the allocations query fails", async () => {
    // A half-loaded receipt beats no receipt on the money path: the document
    // shows its total without the per-invoice breakdown.
    allocationsIn.mockResolvedValue({ data: null, error: { message: "connection lost" } });

    const stored = await renderPaymentReceiptPdfs({
      locale: "en",
      manualPaymentReason: null,
      payments: [PAYMENT_A],
    });

    expect(stored).toHaveLength(1);
    expect(renderedDocuments()[0]).toContain("250 KWD");
  });
});

/**
 * PR #168 review (Codex, P2). The service-charge column arrived by importing a
 * column-list constant from `usePaymentAllocations` — a runtime import, which
 * evaluates that whole module, browser Supabase client included, the moment
 * this server-side renderer loads. It failed under Node with "native WebSocket
 * not found" before a single test ran.
 *
 * The constant now lives in `invoiceExtraCharges`, which imports nothing. This
 * pins the boundary rather than the symptom: the next value pulled across it
 * would break the same way and the error would name WebSockets again.
 */
describe("the server renderer keeps the browser hook type-only", () => {
  const source = readFileSync(resolve(process.cwd(), "src/lib/paymentReceiptPdf.ts"), "utf8");

  /** أسطر الاستيراد من وحدة الخطّاف، كما هي في الملف. */
  const hookImports = source
    .split("\n")
    .filter((line) => line.includes('from "@/hooks/usePaymentAllocations"'));

  it("imports from usePaymentAllocations, and only as a type", () => {
    // Asserted as one exact list rather than a bare negative: "no runtime
    // import" also passes when the import is deleted altogether, and this
    // module does need the allocation type it renders.
    expect(hookImports).toEqual([
      'import type { AllocationWithInvoice } from "@/hooks/usePaymentAllocations";',
    ]);
  });
});
