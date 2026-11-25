/**
 * One definition of "what an invoice document is" — the HTML, the print CSS,
 * the tab title and the download filename.
 *
 * Both the admin invoice sheet and the tenant portal render invoices, and they
 * must produce byte-identical documents: a tenant comparing their download to
 * the copy the office printed should not see two different papers. Keeping the
 * assembly here means neither side can drift.
 */

import type { Company } from "@/hooks/useCompany";
import type { InvoiceWithRelations } from "@/hooks/useInvoices";
import type { InvoicePaymentBreakdown } from "@/lib/invoicePaymentBreakdown";
import { buildInvoicePrintHtml } from "@/lib/invoicePrintHtml";
import { printedDocumentExtraCss } from "@/lib/printedDocument";
import { receiptDocumentFilename } from "@/lib/receiptDocumentFilename";

export interface InvoiceDocument {
  /** Full invoice HTML, ready for print / preview / PDF capture. */
  html: string;
  /** Browser tab title and the PDF's suggested name. */
  title: string;
  /** Download filename, including the .pdf extension. */
  filename: string;
  extraCss: string;
  dir: "rtl";
}

/**
 * يبني مستند فاتورة واحدة: نصّ HTML وعنوان التبويب واسم ملف التنزيل.
 *
 * @param fallbackTitle Used when the company has no name on record, so the tab
 *   never reads as a bare invoice code.
 * @param receiptCode Code of the receipt that settled this invoice, when one is
 *   on record. The file is named after it — see {@link receiptDocumentFilename}.
 */
export function buildInvoiceDocument(
  invoice: InvoiceWithRelations,
  company: Company | null,
  locale: "ar" | "en",
  fallbackTitle: string,
  breakdown: InvoicePaymentBreakdown,
  receiptCode?: string | null,
): InvoiceDocument {
  const companyName = company?.name_ar || company?.name_en || "";

  return {
    html: buildInvoicePrintHtml(invoice, company, locale, breakdown),
    title: `${invoice.code} — ${companyName || fallbackTitle}`,
    filename: receiptDocumentFilename(receiptCode, invoice.code),
    extraCss: printedDocumentExtraCss,
    dir: "rtl",
  };
}

/**
 * يبني مستند الفواتير المسدَّدة بدفعة واحدة — نفس ورقة قسم «الفواتير الشهرية» حرفيًا.
 *
 * The tenant portal's payment row prints the *invoice* paper, not a receipt of
 * its own: the paper the office hands over is what the tenant files, and two
 * different-looking downloads for the same month was the reported complaint.
 * One settled invoice reproduces {@link buildInvoiceDocument} exactly; a
 * payment that settled several invoices prints every one of them, in payment
 * order, inside a single document (one A4 page each).
 *
 * @param breakdowns Snapshot per invoice id. A missing entry is a caller bug —
 *   {@link loadInvoicesDocument} is what fetches them.
 * @param receiptCode Code of the receipt issued for the payment that produced
 *   this paper. It names the file, so the tenant's download and the receipt
 *   they were sent carry one number rather than a joined list of invoice codes.
 */
export function buildInvoicesDocument(
  invoices: InvoiceWithRelations[],
  company: Company | null,
  locale: "ar" | "en",
  fallbackTitle: string,
  breakdowns: Map<string, InvoicePaymentBreakdown>,
  receiptCode?: string | null,
): InvoiceDocument {
  if (!invoices.length) {
    throw new Error("buildInvoicesDocument requires at least one invoice.");
  }
  const companyName = company?.name_ar || company?.name_en || "";
  const codes = invoices.map((invoice) => invoice.code);

  return {
    html: invoices
      .map((invoice) => {
        const breakdown = breakdowns.get(invoice.id);
        if (!breakdown) {
          throw new Error(`Missing payment breakdown for invoice ${invoice.id}`);
        }
        return buildInvoicePrintHtml(invoice, company, locale, breakdown);
      })
      .join("\n"),
    title: `${codes.join(locale === "ar" ? "، " : ", ")} — ${companyName || fallbackTitle}`,
    filename: receiptDocumentFilename(receiptCode, codes.join("_")),
    extraCss: printedDocumentExtraCss,
    dir: "rtl",
  };
}
