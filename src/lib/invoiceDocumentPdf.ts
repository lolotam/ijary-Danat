import { serverCompanyClient } from "@/company/companyClient.server";
import type { Tables } from "@/integrations/supabase/database.types";
import { t, type Locale } from "@/i18n/dictionary";
import { buildInvoiceDocument } from "@/lib/invoiceDocument";
import { parseInvoicePaymentBreakdown } from "@/lib/invoicePaymentBreakdown";
import { loadInvoicesWithRelations } from "@/lib/invoiceRelations";
import { safeFilename } from "@/lib/safeFilename";
import { renderAndStorePdf, type StoredPdf } from "@/lib/reportPdfAttachment";

/** Path prefix inside `report-documents`; `304_storage_company_paths.sql` prefixes with `companies/<companyId>/`. */
const INVOICE_PREFIX = "invoice-documents";

/**
 * يبني ورقة الفاتورة نفسها التي يطبعها المكتب ويخزّنها كـ PDF لإرفاقها بالإرسال اليدوي.
 *
 * Same sheet as the admin print and the portal download (`buildInvoiceDocument`),
 * stored through the receipt path's `renderAndStorePdf`, so the dispatcher
 * attaches it on email and, under Evolution, as a WhatsApp document. Never
 * throws: a send without its attachment is a degradation, a send that never
 * goes out is an outage. Every failure is logged with the invoice code.
 */
export async function renderInvoiceDocumentPdf(input: {
  companyId?: string;
  invoice: Tables<"invoices">;
  locale: Locale;
}): Promise<(StoredPdf & { displayName: string }) | null> {
  const { invoice, locale } = input;
  try {
    const { companyId, client } = serverCompanyClient(input.companyId ?? invoice.company_id);
    const [enriched] = await loadInvoicesWithRelations(client, [invoice]);
    const breakdown = await client.rpc("get_invoice_payment_breakdown", {
      p_invoice_id: invoice.id,
    });
    if (breakdown.error) throw new Error(breakdown.error.message);
    const company = await client.from("companies").select("*").eq("id", companyId).maybeSingle();
    if (company.error) throw new Error(company.error.message);
    const document = buildInvoiceDocument(
      enriched,
      company.data ?? null,
      locale,
      t(locale, "invoices.printInvoice"),
      parseInvoicePaymentBreakdown(breakdown.data),
    );
    const stored = await renderAndStorePdf({
      arabic: true,
      companyId,
      discriminator: invoice.id,
      html: document.html,
      name: invoice.code,
      prefix: INVOICE_PREFIX,
    });
    return stored ? { ...stored, displayName: `${safeFilename(invoice.code)}.pdf` } : null;
  } catch (error) {
    console.error(
      "[invoiceDocumentPdf] render failed",
      invoice.code,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}
