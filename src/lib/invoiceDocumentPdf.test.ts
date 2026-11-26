import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Tables } from "@/integrations/supabase/database.types";

const companyRow = vi.fn();
const breakdownRpc = vi.fn();
const loadRelations = vi.fn();
const renderAndStorePdf = vi.fn();

/**
 * Mocked at the real boundaries only — Postgres and Storage. The invoice
 * sheet builder, the snapshot parser and the filename rule run for real, so
 * these tests prove what actually reaches the renderer and the returned
 * document, not what a stubbed helper was asked for.
 */
const COMPANY_ID = "11111111-1111-4111-8111-111111111111";

vi.mock("@/company/companyClient.server", () => ({
  serverCompanyClient: (explicitCompanyId?: string) => ({
    companyId: explicitCompanyId ?? COMPANY_ID,
    client: {
      from: (table: string) => {
        if (table === "companies") {
          return {
            select: () => ({ eq: () => ({ maybeSingle: companyRow }) }),
          };
        }
        return { select: () => ({ maybeSingle: companyRow }) };
      },
      rpc: (name: string, args: Record<string, unknown>) => breakdownRpc(name, args),
    },
  }),
}));

vi.mock("@/lib/invoiceRelations", () => ({
  loadInvoicesWithRelations: (...args: unknown[]) => loadRelations(...args),
}));

vi.mock("@/lib/reportPdfAttachment", () => ({
  renderAndStorePdf: (...args: unknown[]) => renderAndStorePdf(...args),
}));

const { renderInvoiceDocumentPdf } = await import("./invoiceDocumentPdf");

const INVOICE = {
  id: "inv-1",
  company_id: COMPANY_ID,
  code: "INV-1",
  tenant_id: "tenant-1",
  period_month: 8,
  period_year: 2026,
  issue_date: "2026-08-01",
  due_date: "2026-08-10",
  subtotal: 250,
  discount: 0,
  paid: 0,
  total: 250,
} as unknown as Tables<"invoices">;

/** الفاتورة بعد إثراء علاقاتها، كما تعيدها دالة التحميل في الوحدة الحقيقية. */
function enrichedInvoice() {
  return {
    ...INVOICE,
    contract: null,
    tenant: { name: "Ahmed", name_en: null },
    units: [],
    properties: [],
    unit: null,
    property: null,
    extraCharges: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  loadRelations.mockResolvedValue([enrichedInvoice()]);
  // The snapshot the invoice sheet prints its payments section from. Shaped
  // like the RPC's jsonb, because `parseInvoicePaymentBreakdown` runs for real.
  breakdownRpc.mockResolvedValue({
    data: {
      invoice: {
        code: "INV-1",
        subtotal: 250,
        discount: 0,
        total: 250,
        paid: 0,
        balance: 250,
        state: "due",
      },
      paid_from_allocations: 0,
      reconciled: true,
      groups: [],
    },
    error: null,
  });
  companyRow.mockResolvedValue({ data: null, error: null });
  renderAndStorePdf.mockResolvedValue({
    bucket: "report-documents",
    path: "invoice-documents/INV-1-inv-1-abc123def456.pdf",
  });
});

describe("renderInvoiceDocumentPdf", () => {
  it("stores the invoice sheet and names it after the invoice code", async () => {
    const stored = await renderInvoiceDocumentPdf({ invoice: INVOICE, locale: "en" });

    expect(stored).toEqual({
      bucket: "report-documents",
      path: "invoice-documents/INV-1-inv-1-abc123def456.pdf",
      displayName: "INV-1.pdf",
    });
    expect(renderAndStorePdf).toHaveBeenCalledWith(
      expect.objectContaining({
        prefix: "invoice-documents",
        discriminator: "inv-1",
        name: "INV-1",
        arabic: true,
      }),
    );
  });

  it("reads the payment snapshot through the invoice-anchored RPC", async () => {
    await renderInvoiceDocumentPdf({ invoice: INVOICE, locale: "en" });

    expect(breakdownRpc).toHaveBeenCalledWith("get_invoice_payment_breakdown", {
      p_invoice_id: "inv-1",
    });
  });

  it("returns null, logs once and renders nothing when the breakdown RPC fails", async () => {
    breakdownRpc.mockResolvedValue({ data: null, error: { message: "rpc boom" } });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const stored = await renderInvoiceDocumentPdf({ invoice: INVOICE, locale: "en" });

    expect(stored).toBeNull();
    expect(renderAndStorePdf).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it("returns null when the renderer itself fails, rather than throwing", async () => {
    // Losing the attachment is a degradation; the send must still go out.
    renderAndStorePdf.mockResolvedValue(null);

    const stored = await renderInvoiceDocumentPdf({ invoice: INVOICE, locale: "en" });

    expect(stored).toBeNull();
  });

  it("returns null and logs when the relations loader itself throws", async () => {
    // "Never throws" must hold for a rejection ABOVE the RPC, not only for an
    // RPC error object — the whole body is one try, and this proves it.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    loadRelations.mockRejectedValue(new Error("relations down"));
    await expect(renderInvoiceDocumentPdf({ invoice: INVOICE, locale: "ar" })).resolves.toBeNull();
    expect(renderAndStorePdf).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});
